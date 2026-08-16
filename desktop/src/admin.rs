use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::env;
use std::fs::{OpenOptions, read_to_string};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_ADMIN_RESPONSE_BYTES: u64 = 1024 * 1024;
const ADMIN_TIMEOUT: Duration = Duration::from_secs(4);
const API_DOCS: &str = include_str!("../../docs/api.md");

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyRole {
    Admin,
    Client,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeySummary {
    pub id: String,
    pub label: String,
    pub role: ApiKeyRole,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedApiKey {
    pub id: String,
    pub label: String,
    pub role: ApiKeyRole,
    pub created_at: String,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApiKeyList {
    pub data: Vec<ApiKeySummary>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub token_counts: String,
    pub keys: Vec<KeyUsage>,
}

#[derive(Clone, Debug, Deserialize)]
struct RevokedApiKey {
    id: String,
    status: String,
}

#[derive(Clone, Debug, Deserialize)]
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
        if result.data.len() > 101 || result.data.iter().any(|key| !valid_key_summary(key)) {
            return Err("the local service returned invalid API-key metadata".into());
        }
        Ok(result)
    }

    pub fn create_api_key(&self, label: &str) -> Result<CreatedApiKey, String> {
        let normalized = label.trim();
        if normalized.is_empty() || normalized.chars().count() > 80 {
            return Err("API key label must contain 1-80 characters".into());
        }
        let body = serde_json::to_vec(&serde_json::json!({ "label": normalized }))
            .map_err(|_| "could not encode the API-key request")?;
        let created =
            self.request::<CreatedApiKey>("POST", "/admin/api-keys", Some(&body), ADMIN_TIMEOUT)?;
        if !valid_client_id(&created.id)
            || created.label.is_empty()
            || created.label.chars().count() > 80
            || created.role != ApiKeyRole::Client
            || created.token.len() < 24
            || created.token.len() > 256
            || !created
                .token
                .starts_with(&format!("tab2api_{}_", created.id))
            || created.token.bytes().any(|byte| !byte.is_ascii_graphic())
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
        let token = load_admin_token(&self.data_dir)?;
        self.request_with_token(method, path, body, timeout, token)
    }

    fn request_with_token<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        timeout: Duration,
        token: String,
    ) -> Result<T, String> {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port);
        let mut stream = TcpStream::connect_timeout(&address.into(), timeout)
            .map_err(|_| "the local service is unavailable for administration")?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|_| "could not configure the local administration connection")?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|_| "could not configure the local administration connection")?;
        let body = body.unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.port,
            body.len()
        );
        stream
            .write_all(request.as_bytes())
            .and_then(|()| stream.write_all(body))
            .and_then(|()| stream.flush())
            .map_err(|_| "the local administration request could not be sent")?;
        drop(request);
        drop(token);
        let mut response = Vec::new();
        stream
            .take(MAX_ADMIN_RESPONSE_BYTES + 1)
            .read_to_end(&mut response)
            .map_err(|_| "the local administration request timed out")?;
        if response.len() as u64 > MAX_ADMIN_RESPONSE_BYTES {
            return Err("the local administration response was too large".into());
        }
        parse_json_response(&response)
    }
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
    if !(200..300).contains(&status) {
        return Err(format!(
            "the local administration request failed with HTTP {status}"
        ));
    }
    let body = &response[separator + 4..];
    let chunked = headers.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
        })
    });
    let decoded;
    let body = if chunked {
        decoded = decode_chunked(body)?;
        decoded.as_slice()
    } else {
        body
    };
    serde_json::from_slice(body)
        .map_err(|_| "the local administration response contained invalid JSON".into())
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

fn valid_key_summary(key: &ApiKeySummary) -> bool {
    let valid_id = match key.role {
        ApiKeyRole::Admin => key.id == "local-admin",
        ApiKeyRole::Client => valid_client_id(&key.id),
    };
    valid_id && !key.label.is_empty() && key.label.chars().count() <= 80
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
    fn client_identifiers_and_labels_are_strict() {
        assert!(valid_client_id("0123456789abcdef"));
        assert!(!valid_client_id("../../api-token"));
        assert!(!valid_client_id("0123456789ABCDEF"));
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
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            thread::sleep(Duration::from_millis(150));
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
        server.join().unwrap();
    }

    #[test]
    fn local_admin_request_sends_only_the_expected_loopback_http_shape() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).unwrap();
            let request = std::str::from_utf8(&request[..read]).unwrap();
            assert!(request.starts_with("GET /admin/api-keys HTTP/1.1\r\n"));
            assert!(request.contains("\r\nHost: 127.0.0.1:"));
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
}
