use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::borrow::Cow;
use std::collections::HashSet;
use std::env;
use std::fs::{OpenOptions, read_to_string};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MAX_ADMIN_RESPONSE_BYTES: u64 = 2_621_440;
const ADMIN_TIMEOUT: Duration = Duration::from_secs(4);
const READINESS_TIMEOUT: Duration = Duration::from_secs(45);
const API_DOCS: &str = include_str!("../../docs/api.md");

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyRole {
    Admin,
    Client,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiKeySummary {
    pub id: String,
    pub label: String,
    pub role: ApiKeyRole,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatedApiKey {
    pub id: String,
    pub label: String,
    pub role: ApiKeyRole,
    pub created_at: String,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApiKeyList {
    pub data: Vec<ApiKeySummary>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointUsage {
    pub requests: u64,
    pub successful: u64,
    pub failed: u64,
    pub estimated_input_tokens: u64,
    pub estimated_output_tokens: u64,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub total_latency_ms: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyUsage {
    pub key_id: String,
    pub label: String,
    pub last_used_at: String,
    pub requests: u64,
    pub successful: u64,
    pub failed: u64,
    pub estimated_input_tokens: u64,
    pub estimated_output_tokens: u64,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub total_latency_ms: f64,
    pub endpoints: std::collections::BTreeMap<String, EndpointUsage>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSnapshot {
    pub token_counts: String,
    pub keys: Vec<KeyUsage>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokedApiKey {
    id: String,
    status: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetUsage {
    status: String,
    #[serde(rename = "tokenCounts")]
    token_counts: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedApiDocs {
    pub file_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Ready,
    LoginRequired,
    SecurityChallenge,
    GenerationInProgress,
    RateLimited,
    UiChanged,
    BrowserDisconnected,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReadiness {
    pub ready: bool,
    pub session: SessionState,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadinessResponse {
    status: String,
    session: SessionState,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HealthResponse {
    status: String,
    service: String,
}

pub struct AdminClient {
    port: u16,
    data_dir: PathBuf,
}

impl AdminClient {
    pub fn new(port: u16, data_dir: PathBuf) -> Self {
        Self { port, data_dir }
    }

    pub fn list_api_keys(&self) -> Result<ApiKeyList, String> {
        let result = self.request::<ApiKeyList>("GET", "/admin/api-keys", None, ADMIN_TIMEOUT)?;
        if !valid_api_key_list(&result.data) {
            return Err("the local service returned invalid API-key metadata".into());
        }
        Ok(result)
    }

    pub fn readiness(&self) -> Result<SessionReadiness, String> {
        self.readiness_with_timeout(READINESS_TIMEOUT)
    }

    fn readiness_with_timeout(&self, timeout: Duration) -> Result<SessionReadiness, String> {
        let deadline = request_deadline(timeout)?;
        self.verify_service_identity(deadline)?;
        let token = load_admin_token(&self.data_dir)?;
        let response = self.request_authenticated_bytes("GET", "/readyz", None, deadline, token)?;
        let (status_code, response) = parse_json_response_with_status(&response)?;
        validate_readiness(status_code, response)
    }

    #[cfg(test)]
    fn readiness_with_token_timeout(
        &self,
        timeout: Duration,
        token: String,
    ) -> Result<SessionReadiness, String> {
        let deadline = request_deadline(timeout)?;
        self.verify_service_identity(deadline)?;
        let response = self.request_authenticated_bytes("GET", "/readyz", None, deadline, token)?;
        let (status_code, response) = parse_json_response_with_status(&response)?;
        validate_readiness(status_code, response)
    }

    pub fn create_api_key(&self, label: &str) -> Result<CreatedApiKey, String> {
        let normalized = label.trim();
        if !valid_label(normalized) {
            return Err("API key label must contain 1-80 characters".into());
        }
        let body = serde_json::to_vec(&serde_json::json!({ "label": normalized }))
            .map_err(|_| "could not encode the API-key request")?;
        let created =
            self.request::<CreatedApiKey>("POST", "/admin/api-keys", Some(&body), ADMIN_TIMEOUT)?;
        if !valid_client_id(&created.id)
            || !valid_label(&created.label)
            || created.role != ApiKeyRole::Client
            || !valid_iso_timestamp(&created.created_at)
            || !valid_client_token(&created.id, &created.token)
        {
            return Err("the local service returned an invalid new API key".into());
        }
        Ok(created)
    }

    pub fn revoke_api_key(&self, id: &str) -> Result<(), String> {
        if !valid_client_id(id) {
            return Err("invalid client API-key identifier".into());
        }
        let path = format!("/admin/api-keys/{id}");
        let result = self.request::<RevokedApiKey>("DELETE", &path, None, ADMIN_TIMEOUT)?;
        if result.id != id || result.status != "revoked" {
            return Err("the local service did not confirm API-key revocation".into());
        }
        Ok(())
    }

    pub fn usage(&self) -> Result<UsageSnapshot, String> {
        let result = self.request::<UsageSnapshot>("GET", "/admin/usage", None, ADMIN_TIMEOUT)?;
        if result.token_counts != "estimated"
            || result.keys.len() > 101
            || result.keys.iter().any(|entry| {
                entry.key_id.len() > 64
                    || entry.label.chars().count() > 80
                    || !valid_latency(entry.total_latency_ms)
                    || entry.endpoints.len() > 64
                    || entry.endpoints.iter().any(|(endpoint, usage)| {
                        endpoint.len() > 160
                            || !endpoint.starts_with('/')
                            || !valid_latency(usage.total_latency_ms)
                    })
            })
        {
            return Err("the local service returned invalid usage metadata".into());
        }
        Ok(result)
    }

    pub fn reset_usage(&self) -> Result<(), String> {
        let result = self.request::<ResetUsage>("DELETE", "/admin/usage", None, ADMIN_TIMEOUT)?;
        if result.status != "reset" || result.token_counts != "estimated" {
            return Err("the local service did not confirm the usage reset".into());
        }
        Ok(())
    }

    fn request<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<T, String> {
        let deadline = request_deadline(timeout)?;
        self.verify_service_identity(deadline)?;
        let token = load_admin_token(&self.data_dir)?;
        let response = self.request_authenticated_bytes(method, path, body, deadline, token)?;
        parse_json_response(&response)
    }

    #[cfg(test)]
    fn request_with_token<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        timeout: Duration,
        token: String,
    ) -> Result<T, String> {
        let deadline = request_deadline(timeout)?;
        self.verify_service_identity(deadline)?;
        let response = self.request_authenticated_bytes(method, path, body, deadline, token)?;
        parse_json_response(&response)
    }

    fn verify_service_identity(&self, deadline: Instant) -> Result<(), String> {
        let response = self.request_bytes("GET", "/healthz", None, deadline, None)?;
        let identity = parse_json_response::<HealthResponse>(&response).map_err(|_| {
            "the configured loopback port is not serving tab2api; the administrator key was not sent"
                .to_string()
        })?;
        if identity.status != "ok" || identity.service != "tab2api" {
            return Err(
                "the configured loopback port is not serving tab2api; the administrator key was not sent"
                    .into(),
            );
        }
        Ok(())
    }

    fn request_authenticated_bytes(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        deadline: Instant,
        token: String,
    ) -> Result<Vec<u8>, String> {
        self.request_bytes(method, path, body, deadline, Some(token))
    }

    fn request_bytes(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        deadline: Instant,
        token: Option<String>,
    ) -> Result<Vec<u8>, String> {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port);
        let mut stream =
            TcpStream::connect_timeout(&address.into(), remaining_request_timeout(deadline)?)
                .map_err(|_| "the local service is unavailable for administration")?;
        let remaining = remaining_request_timeout(deadline)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| "could not configure the local administration connection")?;
        stream
            .set_write_timeout(Some(remaining))
            .map_err(|_| "could not configure the local administration connection")?;
        let body = body.unwrap_or_default();
        let content_type = if body.is_empty() {
            ""
        } else {
            "Content-Type: application/json\r\n"
        };
        let request = match token.as_deref() {
            Some(token) => format!(
                "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: application/json\r\nAuthorization: Bearer {token}\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n",
                self.port,
                body.len()
            ),
            None => format!(
                "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                self.port,
                body.len()
            ),
        };
        stream
            .write_all(request.as_bytes())
            .and_then(|()| stream.write_all(body))
            .and_then(|()| stream.flush())
            .map_err(|_| "the local administration request could not be sent")?;
        drop(request);
        drop(token);
        let mut response = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            stream
                .set_read_timeout(Some(remaining_request_timeout(deadline)?))
                .map_err(|_| "could not configure the local administration connection")?;
            let read = stream
                .read(&mut chunk)
                .map_err(|_| "the local administration request timed out")?;
            if read == 0 {
                return Ok(response);
            }
            if response.len().saturating_add(read) > MAX_ADMIN_RESPONSE_BYTES as usize {
                return Err("the local administration response was too large".into());
            }
            response.extend_from_slice(&chunk[..read]);
        }
    }
}

fn request_deadline(timeout: Duration) -> Result<Instant, String> {
    Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| "the local administration request timeout was invalid".into())
}

fn remaining_request_timeout(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "the local administration request timed out".into())
}

fn validate_readiness(
    status_code: u16,
    response: ReadinessResponse,
) -> Result<SessionReadiness, String> {
    let ready = response.session == SessionState::Ready;
    let expected_status = if ready { "ready" } else { "not_ready" };
    let expected_status_code = if ready { 200 } else { 503 };
    if response.status != expected_status || status_code != expected_status_code {
        return Err("the local service returned an inconsistent readiness result".into());
    }
    Ok(SessionReadiness {
        ready,
        session: response.session,
    })
}

fn load_admin_token(data_dir: &Path) -> Result<String, String> {
    let token = match env::var("TAB2API_API_TOKEN") {
        Ok(value) => value,
        Err(env::VarError::NotPresent) => read_to_string(data_dir.join("api-token"))
            .map_err(|_| "the local administrator key is unavailable")?,
        Err(env::VarError::NotUnicode(_)) => {
            return Err("the configured local administrator key is invalid".into());
        }
    };
    let token = token.trim().to_owned();
    if token.len() < 24 || token.len() > 4096 || token.bytes().any(|byte| !byte.is_ascii_graphic())
    {
        return Err("the local administrator key is invalid".into());
    }
    Ok(token)
}

fn parse_json_response<T: DeserializeOwned>(response: &[u8]) -> Result<T, String> {
    let (status, body) = parse_http_response(response)?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "the local administration request failed with HTTP {status}"
        ));
    }
    serde_json::from_slice(&body)
        .map_err(|_| "the local administration response contained invalid JSON".into())
}

fn parse_json_response_with_status<T: DeserializeOwned>(
    response: &[u8],
) -> Result<(u16, T), String> {
    let (status, body) = parse_http_response(response)?;
    let parsed = serde_json::from_slice(&body)
        .map_err(|_| "the local administration response contained invalid JSON".to_string())?;
    Ok((status, parsed))
}

fn parse_http_response(response: &[u8]) -> Result<(u16, Cow<'_, [u8]>), String> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("the local administration response was malformed")?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|_| "the local administration response was malformed")?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("the local administration response was malformed")?;
    let body = &response[separator + 4..];
    let chunked = headers.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
        })
    });
    let body = if chunked {
        Cow::Owned(decode_chunked(body)?)
    } else {
        Cow::Borrowed(body)
    };
    Ok((status, body))
}

fn decode_chunked(encoded: &[u8]) -> Result<Vec<u8>, String> {
    let mut remaining = encoded;
    let mut decoded = Vec::new();
    loop {
        let line_end = remaining
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("the local administration chunked response was malformed")?;
        let size_text = std::str::from_utf8(&remaining[..line_end])
            .map_err(|_| "the local administration chunked response was malformed")?;
        let size_text = size_text
            .split_once(';')
            .map_or(size_text, |(size, _extension)| size)
            .trim();
        if size_text.is_empty() || size_text.len() > 16 {
            return Err("the local administration chunked response was malformed".into());
        }
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| "the local administration chunked response was malformed")?;
        remaining = &remaining[line_end + 2..];
        if size == 0 {
            if remaining != b"\r\n" && !remaining.starts_with(b"\r\n") {
                return Err("the local administration chunked response was malformed".into());
            }
            return Ok(decoded);
        }
        if size > MAX_ADMIN_RESPONSE_BYTES as usize
            || decoded.len().saturating_add(size) > MAX_ADMIN_RESPONSE_BYTES as usize
            || remaining.len() < size + 2
            || &remaining[size..size + 2] != b"\r\n"
        {
            return Err("the local administration chunked response was malformed".into());
        }
        decoded.extend_from_slice(&remaining[..size]);
        remaining = &remaining[size + 2..];
    }
}

fn valid_client_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_api_key_list(keys: &[ApiKeySummary]) -> bool {
    if keys.is_empty() || keys.len() > 101 {
        return false;
    }
    let mut identifiers = HashSet::with_capacity(keys.len());
    keys.iter().enumerate().all(|(index, key)| {
        identifiers.insert(key.id.as_str())
            && valid_label(&key.label)
            && match key.role {
                ApiKeyRole::Admin => {
                    index == 0
                        && key.id == "local-admin"
                        && key.label == "Local administrator"
                        && key.created_at == "runtime"
                        && key.revoked_at.is_none()
                }
                ApiKeyRole::Client => {
                    index > 0
                        && valid_client_id(&key.id)
                        && valid_iso_timestamp(&key.created_at)
                        && key.revoked_at.as_deref().is_none_or(valid_iso_timestamp)
                }
            }
    })
}

fn valid_label(label: &str) -> bool {
    let length = label.chars().count();
    (1..=80).contains(&length) && !label.chars().any(char::is_control)
}

fn valid_iso_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        4 | 7 => *byte == b'-',
        10 => *byte == b'T',
        13 | 16 => *byte == b':',
        19 => *byte == b'.',
        23 => *byte == b'Z',
        _ => byte.is_ascii_digit(),
    })
}

fn valid_client_token(id: &str, token: &str) -> bool {
    let prefix = format!("tab2api_{id}_");
    token.strip_prefix(&prefix).is_some_and(|suffix| {
        suffix.len() == 43
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

fn valid_latency(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

pub fn export_api_docs(download_dir: &Path) -> Result<ExportedApiDocs, String> {
    if !download_dir.is_dir() {
        return Err("the Downloads directory is unavailable".into());
    }
    for suffix in 0..100 {
        let file_name = if suffix == 0 {
            "tab2api-api.md".to_owned()
        } else {
            format!("tab2api-api-{suffix}.md")
        };
        let path = download_dir.join(&file_name);
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(mut file) => {
                file.write_all(API_DOCS.as_bytes())
                    .and_then(|()| file.flush())
                    .map_err(|_| "could not write the API documentation file")?;
                return Ok(ExportedApiDocs { file_name });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("could not create the API documentation file".into()),
        }
    }
    Err("too many tab2api API documentation files already exist in Downloads".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir, read_to_string};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!("tab2api-{name}-{unique}"));
        create_dir(&directory).unwrap();
        directory
    }

    fn accept_request(listener: &TcpListener) -> (TcpStream, String) {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut request = Vec::with_capacity(2048);
        let mut chunk = [0_u8; 512];
        loop {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "the test request ended before it was complete");
            request.extend_from_slice(&chunk[..read]);
            assert!(request.len() <= 2048, "the test request was too large");

            let Some(header_end) = request
                .windows(4)
                .position(|candidate| candidate == b"\r\n\r\n")
                .map(|index| index + 4)
            else {
                continue;
            };
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let request_end = header_end.checked_add(content_length).unwrap();
            assert!(request_end <= 2048, "the test request was too large");
            if request.len() >= request_end {
                request.truncate(request_end);
                break;
            }
        }
        (stream, std::str::from_utf8(&request).unwrap().to_owned())
    }

    fn assert_identity_probe(request: &str) {
        assert!(request.starts_with("GET /healthz HTTP/1.1\r\n"));
        assert!(request.contains("\r\nHost: 127.0.0.1:"));
        assert!(request.contains("\r\nAccept: application/json\r\n"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
    }

    fn respond_with_identity(stream: &mut TcpStream) {
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"status\":\"ok\",\"service\":\"tab2api\"}",
            )
            .unwrap();
    }

    #[test]
    fn parses_only_successful_bounded_json_responses() {
        let parsed: ApiKeyList =
            parse_json_response(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"data\":[]}")
                .unwrap();
        assert!(parsed.data.is_empty());
        assert!(
            parse_json_response::<ApiKeyList>(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}"
            )
            .unwrap_err()
            .contains("HTTP 401")
        );
        assert!(parse_json_response::<ApiKeyList>(b"not HTTP").is_err());
    }

    #[test]
    fn parses_chunked_json_and_rejects_malformed_chunks() {
        let parsed: ApiKeyList = parse_json_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n{\"data\r\n5\r\n\":[]}\r\n0\r\n\r\n",
        )
        .unwrap();
        assert!(parsed.data.is_empty());
        assert!(
            parse_json_response::<ApiKeyList>(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffff\r\n{}\r\n0\r\n\r\n"
            )
            .is_err()
        );
        assert!(
            parse_json_response::<ApiKeyList>(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}xx0\r\n\r\n"
            )
            .is_err()
        );
    }

    #[test]
    fn readiness_contract_accepts_every_typed_session_state() {
        for (session, status_code, status, ready) in [
            (SessionState::Ready, 200, "ready", true),
            (SessionState::LoginRequired, 503, "not_ready", false),
            (SessionState::SecurityChallenge, 503, "not_ready", false),
            (SessionState::GenerationInProgress, 503, "not_ready", false),
            (SessionState::RateLimited, 503, "not_ready", false),
            (SessionState::UiChanged, 503, "not_ready", false),
            (SessionState::BrowserDisconnected, 503, "not_ready", false),
        ] {
            let result = validate_readiness(
                status_code,
                ReadinessResponse {
                    status: status.into(),
                    session: session.clone(),
                },
            )
            .unwrap();
            assert_eq!(result, SessionReadiness { ready, session });
        }
    }

    #[test]
    fn readiness_contract_rejects_inconsistent_or_unknown_results() {
        assert!(
            validate_readiness(
                503,
                ReadinessResponse {
                    status: "not_ready".into(),
                    session: SessionState::Ready,
                },
            )
            .is_err()
        );
        assert!(
            parse_json_response_with_status::<ReadinessResponse>(
                b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 49\r\n\r\n{\"status\":\"not_ready\",\"session\":\"unknown_state\"}",
            )
            .is_err()
        );
    }

    #[test]
    fn client_identifiers_and_labels_are_strict() {
        assert!(valid_client_id("0123456789abcdef"));
        assert!(!valid_client_id("../../api-token"));
        assert!(!valid_client_id("0123456789ABCDEF"));
        assert!(valid_label("Personal laptop"));
        assert!(!valid_label("bad\u{1b}label"));
        assert!(valid_iso_timestamp("2026-08-23T00:00:00.000Z"));
        assert!(!valid_iso_timestamp("2026-08-23 00:00:00Z"));
        assert!(valid_client_token(
            "0123456789abcdef",
            &format!("tab2api_0123456789abcdef_{}", "A".repeat(43))
        ));
        assert!(!valid_client_token(
            "0123456789abcdef",
            "tab2api_0123456789abcdef_too-short"
        ));

        let administrator = ApiKeySummary {
            id: "local-admin".into(),
            label: "Local administrator".into(),
            role: ApiKeyRole::Admin,
            created_at: "runtime".into(),
            revoked_at: None,
        };
        let client = ApiKeySummary {
            id: "0123456789abcdef".into(),
            label: "Personal laptop".into(),
            role: ApiKeyRole::Client,
            created_at: "2026-08-23T00:00:00.000Z".into(),
            revoked_at: None,
        };
        assert!(valid_api_key_list(&[administrator.clone(), client.clone()]));
        assert!(!valid_api_key_list(&[]));
        assert!(!valid_api_key_list(&[
            client.clone(),
            administrator.clone()
        ]));
        assert!(!valid_api_key_list(&[
            administrator,
            client.clone(),
            client
        ]));
        assert!(
            parse_json_response::<ApiKeyList>(
                b"HTTP/1.1 200 OK\r\n\r\n{\"data\":[],\"unexpected\":true}"
            )
            .is_err()
        );
    }

    #[test]
    fn markdown_export_never_overwrites_an_existing_file() {
        let directory = temporary_directory("docs-export");
        std::fs::write(directory.join("tab2api-api.md"), "keep").unwrap();
        let exported = export_api_docs(&directory).unwrap();
        assert_eq!(exported.file_name, "tab2api-api-1.md");
        assert_eq!(
            read_to_string(directory.join("tab2api-api.md")).unwrap(),
            "keep"
        );
        let contents = read_to_string(directory.join(exported.file_name)).unwrap();
        assert!(contents.contains("POST /v1/chat/completions"));
        assert!(!contents.contains("tab2api_0123456789abcdef_"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn local_admin_request_times_out_without_leaking_the_key() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release_sender, release_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (_stream, request) = accept_request(&listener);
            assert_identity_probe(&request);
            release_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
        });
        let client = AdminClient::new(port, PathBuf::new());
        let secret = "test-administrator-key-never-report";
        let error = client
            .request_with_token::<ApiKeyList>(
                "GET",
                "/admin/api-keys",
                None,
                Duration::from_millis(30),
                secret.to_owned(),
            )
            .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(!error.contains(secret));
        release_sender.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn local_admin_request_sends_only_the_expected_loopback_http_shape() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut identity_stream, identity_request) = accept_request(&listener);
            assert_identity_probe(&identity_request);
            respond_with_identity(&mut identity_stream);
            drop(identity_stream);

            let (mut stream, request) = accept_request(&listener);
            assert!(request.starts_with("GET /admin/api-keys HTTP/1.1\r\n"));
            assert!(request.contains("\r\nHost: 127.0.0.1:"));
            assert!(request.contains("\r\nAccept: application/json\r\n"));
            assert!(!request.contains("\r\nContent-Type:"));
            assert!(
                request
                    .contains("\r\nAuthorization: Bearer test-administrator-key-never-report\r\n")
            );
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":[]}",
                )
                .unwrap();
        });
        let client = AdminClient::new(port, PathBuf::new());
        let result = client
            .request_with_token::<ApiKeyList>(
                "GET",
                "/admin/api-keys",
                None,
                Duration::from_secs(1),
                "test-administrator-key-never-report".to_owned(),
            )
            .unwrap();
        assert!(result.data.is_empty());
        server.join().unwrap();
    }

    #[test]
    fn empty_authenticated_delete_omits_json_content_type() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut identity_stream, identity_request) = accept_request(&listener);
            assert_identity_probe(&identity_request);
            respond_with_identity(&mut identity_stream);
            drop(identity_stream);

            let (mut stream, request) = accept_request(&listener);
            assert!(request.starts_with("DELETE /admin/api-keys/0123456789abcdef HTTP/1.1\r\n"));
            assert!(request.contains("\r\nContent-Length: 0\r\n"));
            assert!(!request.contains("\r\nContent-Type:"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"status\":\"revoked\",\"id\":\"0123456789abcdef\"}",
                )
                .unwrap();
        });
        let client = AdminClient::new(port, PathBuf::new());
        let result = client
            .request_with_token::<RevokedApiKey>(
                "DELETE",
                "/admin/api-keys/0123456789abcdef",
                None,
                Duration::from_secs(1),
                "test-administrator-key-never-report".to_owned(),
            )
            .unwrap();
        assert_eq!(result.status, "revoked");
        assert_eq!(result.id, "0123456789abcdef");
        server.join().unwrap();
    }

    #[test]
    fn nonempty_authenticated_request_keeps_json_content_type() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut identity_stream, identity_request) = accept_request(&listener);
            assert_identity_probe(&identity_request);
            respond_with_identity(&mut identity_stream);
            drop(identity_stream);

            let (mut stream, request) = accept_request(&listener);
            assert!(request.starts_with("POST /admin/api-keys HTTP/1.1\r\n"));
            assert!(request.contains("\r\nContent-Type: application/json\r\n"));
            assert!(request.contains("\r\nContent-Length: 18\r\n"));
            assert!(request.ends_with("\r\n\r\n{\"label\":\"Laptop\"}"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}")
                .unwrap();
        });
        let client = AdminClient::new(port, PathBuf::new());
        let result = client
            .request_with_token::<serde_json::Value>(
                "POST",
                "/admin/api-keys",
                Some(b"{\"label\":\"Laptop\"}"),
                Duration::from_secs(1),
                "test-administrator-key-never-report".to_owned(),
            )
            .unwrap();
        assert_eq!(result, serde_json::json!({}));
        server.join().unwrap();
    }

    #[test]
    fn unrelated_loopback_service_never_receives_the_administrator_key() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, request) = accept_request(&listener);
            assert_identity_probe(&request);
            assert!(!request.contains("test-administrator-key-never-report"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"status\":\"ok\",\"service\":\"another-service\"}",
                )
                .unwrap();
        });
        let client = AdminClient::new(port, PathBuf::new());
        let secret = "test-administrator-key-never-report";
        let error = client
            .request_with_token::<ApiKeyList>(
                "GET",
                "/admin/api-keys",
                None,
                Duration::from_secs(1),
                secret.to_owned(),
            )
            .unwrap_err();
        assert!(error.contains("administrator key was not sent"));
        assert!(!error.contains(secret));
        server.join().unwrap();
    }

    #[test]
    fn readiness_request_accepts_a_typed_non_ready_response_without_exposing_the_key() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut identity_stream, identity_request) = accept_request(&listener);
            assert_identity_probe(&identity_request);
            respond_with_identity(&mut identity_stream);
            drop(identity_stream);

            let (mut stream, request) = accept_request(&listener);
            assert!(request.starts_with("GET /readyz HTTP/1.1\r\n"));
            assert!(request.contains("\r\nHost: 127.0.0.1:"));
            assert!(request.contains("\r\nAccept: application/json\r\n"));
            assert!(
                request
                    .contains("\r\nAuthorization: Bearer test-administrator-key-never-report\r\n")
            );
            stream
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n{\"status\":\"not_ready\",\"session\":\"login_required\"}",
                )
                .unwrap();
        });
        let client = AdminClient::new(port, PathBuf::new());
        let result = client
            .readiness_with_token_timeout(
                Duration::from_secs(1),
                "test-administrator-key-never-report".to_owned(),
            )
            .unwrap();
        assert_eq!(
            result,
            SessionReadiness {
                ready: false,
                session: SessionState::LoginRequired,
            }
        );
        server.join().unwrap();
    }

    #[test]
    fn readiness_request_is_bounded_and_never_leaks_the_key() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release_sender, release_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (_stream, request) = accept_request(&listener);
            assert_identity_probe(&request);
            release_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap();
        });
        let client = AdminClient::new(port, PathBuf::new());
        let secret = "test-readiness-key-never-report";
        let error = client
            .readiness_with_token_timeout(Duration::from_millis(30), secret.to_owned())
            .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(!error.contains(secret));
        release_sender.send(()).unwrap();
        server.join().unwrap();
    }
}
