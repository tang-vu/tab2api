#!/usr/bin/env node
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_WORKFLOW_FILES = 64;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_ACTION_REFERENCES = 256;
const WORKFLOW_FILE = /\.ya?ml$/u;
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/u;
const CONTAINER_DIGEST = /^docker:\/\/([A-Za-z0-9._:/-]+)@sha256:[a-f0-9]{64}$/u;
const ACTION_VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:\s+#\s*(.+))?$/u;
const USES_PREFIX = /^\s*(?:-\s*)?uses:/u;
const ACTION_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/u;

export interface WorkflowSource {
  fileName: string;
  contents: string;
}

export interface WorkflowActionReference {
  reference: string;
  lineNumber: number;
  version?: string;
}

export function collectActionReferences(source: WorkflowSource): WorkflowActionReference[] {
  const references: WorkflowActionReference[] = [];
  for (const [index, line] of source.contents.split(/\r?\n/u).entries()) {
    if (!USES_PREFIX.test(line)) continue;
    const match = USES_LINE.exec(line);
    const reference = match?.[1] ?? match?.[2] ?? match?.[3];
    if (reference === undefined) {
      throw new Error(`${source.fileName}:${index + 1} has a malformed uses entry.`);
    }
    const version = match?.[4]?.trim();
    references.push({
      reference,
      lineNumber: index + 1,
      ...(version === undefined ? {} : { version }),
    });
  }
  return references;
}

function normalizedLocalAction(reference: string): boolean {
  const relative = reference.slice(2);
  return (
    relative.length > 0 &&
    !relative.includes('\\') &&
    !path.posix.isAbsolute(relative) &&
    path.posix.normalize(relative) === relative &&
    relative
      .split('/')
      .every((segment) => segment !== '.' && segment !== '..' && ACTION_PATH_SEGMENT.test(segment))
  );
}

export function isImmutableActionReference(reference: string): boolean {
  if (reference.startsWith('./')) return normalizedLocalAction(reference);
  if (reference.startsWith('docker://')) {
    const image = CONTAINER_DIGEST.exec(reference)?.[1];
    return (
      image !== undefined &&
      !image.includes('//') &&
      image.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    );
  }

  const separator = reference.lastIndexOf('@');
  if (separator <= 0 || !FULL_COMMIT_SHA.test(reference.slice(separator + 1))) return false;
  const segments = reference.slice(0, separator).split('/');
  return (
    segments.length >= 2 &&
    segments.every(
      (segment) => segment !== '.' && segment !== '..' && ACTION_PATH_SEGMENT.test(segment),
    )
  );
}

export function verifyWorkflowActionPins(sources: readonly WorkflowSource[]): number {
  if (sources.length === 0 || sources.length > MAX_WORKFLOW_FILES) {
    throw new Error('Workflow file count is outside its allowed bound.');
  }
  let referenceCount = 0;
  for (const source of sources) {
    const references = collectActionReferences(source);
    referenceCount += references.length;
    if (referenceCount > MAX_ACTION_REFERENCES) {
      throw new Error('Workflow action-reference count is outside its allowed bound.');
    }
    for (const action of references) {
      if (!isImmutableActionReference(action.reference)) {
        throw new Error(
          `${source.fileName}:${action.lineNumber} uses mutable or invalid action reference ${action.reference}.`,
        );
      }
      if (
        !action.reference.startsWith('./') &&
        !action.reference.startsWith('docker://') &&
        (action.version === undefined || !ACTION_VERSION.test(action.version))
      ) {
        throw new Error(
          `${source.fileName}:${action.lineNumber} must annotate its pinned action with an exact version.`,
        );
      }
    }
  }
  if (referenceCount === 0) {
    throw new Error('No GitHub Actions references were found for verification.');
  }
  return referenceCount;
}

export async function readWorkflowSources(rootDirectory: string): Promise<WorkflowSource[]> {
  const workflowDirectory = path.join(rootDirectory, '.github', 'workflows');
  const entries = (await readdir(workflowDirectory, { withFileTypes: true }))
    .filter(({ name }) => WORKFLOW_FILE.test(name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0 || entries.length > MAX_WORKFLOW_FILES) {
    throw new Error('Workflow file count is outside its allowed bound.');
  }

  const sources: WorkflowSource[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error(`Workflow ${entry.name} must be an ordinary file.`);
    const workflowPath = path.join(workflowDirectory, entry.name);
    const metadata = await lstat(workflowPath);
    if (!metadata.isFile() || metadata.size > MAX_WORKFLOW_BYTES) {
      throw new Error(`Workflow ${entry.name} is not a bounded ordinary file.`);
    }
    sources.push({ fileName: entry.name, contents: await readFile(workflowPath, 'utf8') });
  }
  return sources;
}

async function main(): Promise<void> {
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const referenceCount = verifyWorkflowActionPins(await readWorkflowSources(rootDirectory));
  process.stdout.write(
    `Workflow pinning PASS: ${referenceCount} immutable action references verified.\n`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Workflow pinning failed: ${error instanceof Error ? error.message : 'unexpected error'}\n`,
    );
    process.exitCode = 1;
  });
}
