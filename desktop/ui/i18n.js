export const languageOptions = [
  ['en', 'English'],
  ['vi', 'Tiếng Việt'],
  ['zh', '中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
];

const en = {
  appTitle: 'tab2api',
  appSubtitle: 'Local browser bridge controller',
  settings: 'Settings',
  checking: 'Checking...',
  inspectingService: 'Inspecting the local sidecar.',
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Ready',
  unhealthy: 'Needs attention',
  loginOpen: 'Login browser open',
  serviceStopped: 'The local service is stopped.',
  serviceStarting: 'Starting the loopback-only service and dedicated browser.',
  serviceReady: 'The local API and dedicated browser are ready.',
  serviceUnhealthy: 'The process is running but its loopback health check failed.',
  serviceLoginOpen: 'Close the manual login browser before starting the service.',
  startService: 'Start service',
  stopService: 'Stop service',
  openLogin: 'Open login browser',
  refreshStatus: 'Refresh status',
  openExternally: 'Open externally',
  dockBrowser: 'Dock browser',
  tunnelTitle: 'Personal Cloudflare Tunnel',
  inspectingTunnel: 'Inspecting optional remote access.',
  tunnelDisabled: 'Disabled',
  tunnelUnknown: 'Unknown mode',
  tunnelAccess: 'Access protected',
  tunnelBearer: 'Bearer-only',
  tunnelUnsupported: 'Unsupported',
  tunnelRunningAccess: 'Cloudflare Tunnel is running with Access protection.',
  tunnelRunningBearer: 'Cloudflare Tunnel is running in explicit single-owner bearer-only mode.',
  tunnelRunningUnknown: 'Cloudflare Tunnel is running with an unknown protection mode.',
  tunnelInstalledStopped: 'Cloudflare Tunnel is installed but not running.',
  tunnelNeedsInstall: 'Install cloudflared to enable optional personal remote access.',
  tunnelNeedsConfig: 'Private tunnel configuration is required before activation.',
  tunnelReady: 'Cloudflare Tunnel is ready to enable.',
  cloudflared: 'cloudflared',
  tunnelConfig: 'tunnel config',
  accessProbe: 'Access probe',
  prerequisiteReady: 'ready',
  prerequisiteMissing: 'missing',
  installCloudflared: 'Install cloudflared',
  enableAccess: 'Enable with Access',
  enableBearer: 'Enable bearer-only...',
  disableTunnel: 'Disable tunnel',
  openSetupFolder: 'Open setup folder',
  guideTitle: 'Cloudflare setup guide',
  guideIntro:
    'Remote access remains optional and single-owner. The local origin and browser control always stay on loopback.',
  guideInstallTitle: '1. Install cloudflared',
  guideInstallBody:
    'Use the button above. The app installs the exact Cloudflare.cloudflared package through Windows Package Manager.',
  guideTunnelTitle: '2. Create a dedicated tunnel and DNS route',
  guideTunnelBody:
    'In Cloudflare Zero Trust, create a new tunnel used only by tab2api. Route your hostname to http://127.0.0.1:3210. Never route the browser DevTools port.',
  guideFilesTitle: '3. Place the private runtime files',
  guideFilesBody:
    'Put cloudflared-tab2api.yml and cloudflared-access-probe.yml in the private setup folder. Credential JSON files stay private and are never displayed or copied by this app.',
  guideAccessTitle: '4. Protect the entire hostname with Access',
  guideAccessBody:
    'Add a Self-hosted Access application for the whole hostname. Use deny-by-default policies: allow only the owner with MFA, or one Service Auth token per unattended device. Never add Everyone or Bypass.',
  guideKeyTitle: '5. Keep independent tab2api authentication',
  guideKeyBody:
    'Every remote device must also use its own revocable tab2api client key. Cloudflare Access does not replace the Authorization bearer key.',
  guideActivateTitle: '6. Verify and enable',
  guideActivateBody:
    'Choose Enable with Access. The app publishes only a fixed HTTP 418 probe first and continues only when Access redirects it to cloudflareaccess.com.',
  guideBearerTitle: 'Bearer-only alternative',
  guideBearerBody:
    'Use only for one owner who explicitly accepts a publicly reachable hostname. Protected API routes still require a revocable tab2api key; only cheap /healthz remains public.',
  privateTitle: 'Private by design',
  privateBody:
    'The API and browser control stay on loopback. Login happens manually in a dedicated Chromium profile. The system WebView never loads ChatGPT.',
  browserTitle: 'Dedicated browser',
  browserNotRunning: 'Not running',
  browserExternal: 'External window',
  browserDocked: 'Docked',
  browserMeta: 'Manual profile · loopback control · external fallback',
  browserPane: 'Browser pane',
  browserPlaceholder: 'Start the service to launch the dedicated ChatGPT window.',
  settingsTitle: 'Settings',
  language: 'Language',
  automaticLocale: 'On first launch, language is selected from the operating-system locale.',
  localePrivacyTitle: 'Locale privacy',
  localePrivacyBody:
    'Language detection is local. tab2api never sends your IP address or locale to a geolocation service.',
  remoteSafetyTitle: 'Remote-access safety',
  remoteSafetyBody:
    'Cloudflare Access is recommended. Bearer-only remains a separate explicit single-owner choice.',
  close: 'Close',
  confirmBearer:
    'Bearer-only makes the hostname publicly reachable. Continue only for one owner, with an independent revocable tab2api client key. Cloudflare Access is safer. Enable bearer-only mode?',
  nativeBridgeError:
    'Native bridge initialization failed. Restart tab2api; reinstall the desktop app if this persists.',
  bridgeUnavailable: 'Desktop bridge unavailable',
  bridgeUnavailableDetail: 'The native command API was not injected into this window.',
  accessActivationError:
    'Cloudflare Access did not intercept the fixed probe. Configure a Self-hosted Access application for the entire hostname, then retry.',
  bearerActivationError:
    'Windows could not start the bearer-only Scheduled Task after a bounded retry. Confirm Task Scheduler is available, then retry.',
};

const vi = {
  ...en,
  appSubtitle: 'Bộ điều khiển cầu nối trình duyệt cục bộ',
  settings: 'Cài đặt',
  checking: 'Đang kiểm tra...',
  inspectingService: 'Đang kiểm tra sidecar cục bộ.',
  stopped: 'Đã dừng',
  starting: 'Đang khởi động',
  ready: 'Sẵn sàng',
  unhealthy: 'Cần kiểm tra',
  loginOpen: 'Trình duyệt đăng nhập đang mở',
  serviceStopped: 'Dịch vụ cục bộ đang dừng.',
  serviceStarting: 'Đang khởi động dịch vụ loopback và trình duyệt riêng.',
  serviceReady: 'API cục bộ và trình duyệt riêng đã sẵn sàng.',
  serviceUnhealthy: 'Tiến trình đang chạy nhưng kiểm tra sức khỏe loopback thất bại.',
  serviceLoginOpen: 'Hãy đóng trình duyệt đăng nhập thủ công trước khi bật dịch vụ.',
  startService: 'Bật dịch vụ',
  stopService: 'Dừng dịch vụ',
  openLogin: 'Mở trình duyệt đăng nhập',
  refreshStatus: 'Làm mới trạng thái',
  openExternally: 'Mở cửa sổ riêng',
  dockBrowser: 'Gắn trình duyệt',
  tunnelTitle: 'Cloudflare Tunnel cá nhân',
  inspectingTunnel: 'Đang kiểm tra truy cập từ xa tùy chọn.',
  tunnelDisabled: 'Đang tắt',
  tunnelUnknown: 'Không rõ chế độ',
  tunnelAccess: 'Được Access bảo vệ',
  tunnelBearer: 'Chỉ bearer key',
  tunnelUnsupported: 'Không hỗ trợ',
  tunnelRunningAccess: 'Cloudflare Tunnel đang chạy với lớp bảo vệ Access.',
  tunnelRunningBearer: 'Cloudflare Tunnel đang chạy ở chế độ chỉ bearer key cho một chủ sở hữu.',
  tunnelRunningUnknown: 'Cloudflare Tunnel đang chạy với chế độ bảo vệ không xác định.',
  tunnelInstalledStopped: 'Cloudflare Tunnel đã được cài nhưng chưa chạy.',
  tunnelNeedsInstall: 'Cài cloudflared để bật truy cập từ xa cá nhân tùy chọn.',
  tunnelNeedsConfig: 'Cần cấu hình tunnel riêng trước khi kích hoạt.',
  tunnelReady: 'Cloudflare Tunnel đã sẵn sàng để bật.',
  tunnelConfig: 'cấu hình tunnel',
  accessProbe: 'kiểm tra Access',
  prerequisiteReady: 'sẵn sàng',
  prerequisiteMissing: 'còn thiếu',
  installCloudflared: 'Cài cloudflared',
  enableAccess: 'Bật với Access',
  enableBearer: 'Bật chế độ bearer-only...',
  disableTunnel: 'Tắt tunnel',
  openSetupFolder: 'Mở thư mục thiết lập',
  guideTitle: 'Hướng dẫn thiết lập Cloudflare',
  guideIntro:
    'Truy cập từ xa là tùy chọn và chỉ dành cho một chủ sở hữu. Origin cục bộ và DevTools luôn ở loopback.',
  guideInstallTitle: '1. Cài cloudflared',
  guideInstallBody:
    'Dùng nút phía trên. App cài đúng gói Cloudflare.cloudflared qua Windows Package Manager.',
  guideTunnelTitle: '2. Tạo tunnel và DNS route riêng',
  guideTunnelBody:
    'Trong Cloudflare Zero Trust, tạo tunnel mới chỉ dùng cho tab2api. Trỏ hostname đến http://127.0.0.1:3210. Tuyệt đối không tunnel cổng DevTools của trình duyệt.',
  guideFilesTitle: '3. Đặt các file runtime riêng tư',
  guideFilesBody:
    'Đặt cloudflared-tab2api.yml và cloudflared-access-probe.yml vào thư mục thiết lập riêng. File credential JSON phải luôn riêng tư; app không hiển thị hay sao chép chúng.',
  guideAccessTitle: '4. Bảo vệ toàn bộ hostname bằng Access',
  guideAccessBody:
    'Tạo ứng dụng Access loại Self-hosted cho toàn bộ hostname. Dùng chính sách mặc định từ chối: chỉ cho phép chủ sở hữu có MFA, hoặc một Service Auth token cho mỗi thiết bị tự động. Không dùng Everyone hoặc Bypass.',
  guideKeyTitle: '5. Giữ lớp xác thực tab2api độc lập',
  guideKeyBody:
    'Mỗi thiết bị từ xa vẫn phải dùng một tab2api client key riêng có thể thu hồi. Cloudflare Access không thay thế bearer key trong Authorization.',
  guideActivateTitle: '6. Kiểm tra và kích hoạt',
  guideActivateBody:
    'Chọn Bật với Access. App chỉ public probe HTTP 418 cố định trước, và chỉ tiếp tục khi Access chuyển hướng đến cloudflareaccess.com.',
  guideBearerTitle: 'Phương án bearer-only',
  guideBearerBody:
    'Chỉ dùng cho một chủ sở hữu chủ động chấp nhận hostname có thể truy cập công khai. Các API được bảo vệ vẫn cần tab2api key có thể thu hồi; chỉ /healthz nhẹ là public.',
  privateTitle: 'Riêng tư theo thiết kế',
  privateBody:
    'API và điều khiển trình duyệt luôn ở loopback. Bạn đăng nhập thủ công trong profile Chromium riêng. System WebView không bao giờ tải ChatGPT.',
  browserTitle: 'Trình duyệt riêng',
  browserNotRunning: 'Chưa chạy',
  browserExternal: 'Cửa sổ riêng',
  browserDocked: 'Đã gắn',
  browserMeta: 'Profile thủ công · điều khiển loopback · dự phòng cửa sổ riêng',
  browserPane: 'Khung trình duyệt',
  browserPlaceholder: 'Bật dịch vụ để mở cửa sổ ChatGPT riêng.',
  settingsTitle: 'Cài đặt',
  language: 'Ngôn ngữ',
  automaticLocale: 'Lần chạy đầu, ngôn ngữ được chọn theo locale của hệ điều hành.',
  localePrivacyTitle: 'Quyền riêng tư locale',
  localePrivacyBody:
    'Việc nhận diện ngôn ngữ diễn ra cục bộ. tab2api không gửi địa chỉ IP hoặc locale đến dịch vụ định vị.',
  remoteSafetyTitle: 'An toàn truy cập từ xa',
  remoteSafetyBody:
    'Khuyến nghị Cloudflare Access. Bearer-only luôn là lựa chọn riêng, rõ ràng và chỉ cho một chủ sở hữu.',
  close: 'Đóng',
  confirmBearer:
    'Bearer-only khiến hostname có thể truy cập công khai. Chỉ tiếp tục cho một chủ sở hữu và dùng tab2api client key riêng có thể thu hồi. Cloudflare Access an toàn hơn. Bật bearer-only?',
  nativeBridgeError:
    'Khởi tạo cầu nối native thất bại. Hãy khởi động lại tab2api; cài lại app nếu lỗi tiếp diễn.',
  bridgeUnavailable: 'Cầu nối desktop không khả dụng',
  bridgeUnavailableDetail: 'Native command API chưa được đưa vào cửa sổ này.',
  accessActivationError:
    'Cloudflare Access chưa chặn probe cố định. Hãy tạo ứng dụng Access loại Self-hosted cho toàn bộ hostname rồi thử lại.',
  bearerActivationError:
    'Windows chưa thể bật Scheduled Task bearer-only sau một lần thử lại có giới hạn. Hãy kiểm tra Task Scheduler rồi thử lại.',
};

const zh = {
  ...en,
  appSubtitle: '本地浏览器桥接控制器',
  settings: '设置',
  checking: '正在检查...',
  stopped: '已停止',
  starting: '正在启动',
  ready: '就绪',
  unhealthy: '需要检查',
  startService: '启动服务',
  stopService: '停止服务',
  openLogin: '打开登录浏览器',
  refreshStatus: '刷新状态',
  openExternally: '外部打开',
  dockBrowser: '停靠浏览器',
  tunnelTitle: '个人 Cloudflare Tunnel',
  tunnelDisabled: '已禁用',
  tunnelAccess: 'Access 保护',
  tunnelBearer: '仅 Bearer',
  installCloudflared: '安装 cloudflared',
  enableAccess: '使用 Access 启用',
  enableBearer: '启用仅 Bearer...',
  disableTunnel: '禁用隧道',
  openSetupFolder: '打开设置文件夹',
  guideTitle: 'Cloudflare 设置指南',
  guideIntro: '远程访问仅供单一所有者选择使用。本地服务和浏览器控制始终绑定到 loopback。',
  guideInstallTitle: '1. 安装 cloudflared',
  guideInstallBody:
    '使用上方按钮通过 Windows Package Manager 安装准确的 Cloudflare.cloudflared 包。',
  guideTunnelTitle: '2. 创建专用隧道和 DNS 路由',
  guideTunnelBody:
    '在 Cloudflare Zero Trust 中创建仅供 tab2api 使用的新隧道。将主机名路由到 http://127.0.0.1:3210，切勿暴露浏览器 DevTools 端口。',
  guideFilesTitle: '3. 放置私有运行时文件',
  guideFilesBody:
    '将 cloudflared-tab2api.yml 和 cloudflared-access-probe.yml 放入私有设置文件夹。应用不会显示或复制凭据。',
  guideAccessTitle: '4. 使用 Access 保护整个主机名',
  guideAccessBody:
    '为整个主机名创建 Self-hosted Access 应用。默认拒绝，仅允许启用 MFA 的所有者，或为每台无人值守设备使用独立 Service Auth token。禁止 Everyone 或 Bypass。',
  guideKeyTitle: '5. 保留独立的 tab2api 身份验证',
  guideKeyBody:
    '每台远程设备还必须使用独立且可撤销的 tab2api client key。Access 不能替代 Authorization bearer key。',
  guideActivateTitle: '6. 验证并启用',
  guideActivateBody:
    '选择“使用 Access 启用”。应用先发布固定 HTTP 418 探针，只有 Access 将其重定向到 cloudflareaccess.com 后才继续。',
  guideBearerTitle: '仅 Bearer 方案',
  guideBearerBody:
    '仅限明确接受公开主机名风险的单一所有者。受保护 API 仍需要可撤销的 tab2api key。',
  privateTitle: '隐私优先设计',
  privateBody:
    'API 和浏览器控制保持在 loopback。登录仅在专用 Chromium 配置中手动完成。系统 WebView 从不加载 ChatGPT。',
  browserTitle: '专用浏览器',
  browserNotRunning: '未运行',
  browserExternal: '外部窗口',
  browserDocked: '已停靠',
  browserPane: '浏览器窗格',
  browserPlaceholder: '启动服务以打开专用 ChatGPT 窗口。',
  settingsTitle: '设置',
  language: '语言',
  automaticLocale: '首次启动时根据操作系统区域设置选择语言。',
  localePrivacyTitle: '区域隐私',
  localePrivacyBody: '语言检测完全在本地完成，tab2api 不会发送您的 IP 地址或区域设置。',
  remoteSafetyTitle: '远程访问安全',
  remoteSafetyBody: '推荐 Cloudflare Access。仅 Bearer 模式始终需要单独明确确认。',
  close: '关闭',
};

const ja = {
  ...en,
  appSubtitle: 'ローカルブラウザーブリッジコントローラー',
  settings: '設定',
  checking: '確認中...',
  stopped: '停止',
  starting: '起動中',
  ready: '準備完了',
  unhealthy: '要確認',
  startService: 'サービス開始',
  stopService: 'サービス停止',
  openLogin: 'ログインブラウザーを開く',
  refreshStatus: '状態を更新',
  openExternally: '外部で開く',
  dockBrowser: 'ブラウザーをドッキング',
  tunnelTitle: '個人用 Cloudflare Tunnel',
  tunnelDisabled: '無効',
  tunnelAccess: 'Access 保護',
  tunnelBearer: 'Bearer のみ',
  installCloudflared: 'cloudflared をインストール',
  enableAccess: 'Access で有効化',
  enableBearer: 'Bearer のみで有効化...',
  disableTunnel: 'トンネルを無効化',
  openSetupFolder: '設定フォルダーを開く',
  guideTitle: 'Cloudflare セットアップガイド',
  guideIntro:
    'リモートアクセスは単一所有者向けの任意機能です。ローカルオリジンとブラウザー制御は常に loopback に留まります。',
  guideInstallTitle: '1. cloudflared をインストール',
  guideInstallBody:
    '上のボタンから Windows Package Manager で正規の Cloudflare.cloudflared パッケージをインストールします。',
  guideTunnelTitle: '2. 専用トンネルと DNS ルートを作成',
  guideTunnelBody:
    'Cloudflare Zero Trust で tab2api 専用トンネルを作成し、ホスト名を http://127.0.0.1:3210 に向けます。DevTools ポートは公開しないでください。',
  guideFilesTitle: '3. 非公開ランタイムファイルを配置',
  guideFilesBody:
    'cloudflared-tab2api.yml と cloudflared-access-probe.yml を非公開設定フォルダーに置きます。認証情報は表示・コピーされません。',
  guideAccessTitle: '4. ホスト名全体を Access で保護',
  guideAccessBody:
    'ホスト名全体に Self-hosted Access アプリを作成します。既定拒否とし、MFA を使う所有者、または端末ごとの Service Auth token のみ許可します。Everyone や Bypass は禁止です。',
  guideKeyTitle: '5. tab2api 認証も維持',
  guideKeyBody:
    '各リモート端末には個別の取り消し可能な tab2api client key が必要です。Access は Authorization bearer key の代わりではありません。',
  guideActivateTitle: '6. 検証して有効化',
  guideActivateBody:
    '「Access で有効化」を選びます。固定 HTTP 418 プローブが cloudflareaccess.com に転送された場合のみ続行します。',
  guideBearerTitle: 'Bearer のみの代替',
  guideBearerBody: '公開ホスト名のリスクを明示的に受け入れる単一所有者のみ使用してください。',
  privateTitle: 'プライバシー重視',
  privateBody:
    'API とブラウザー制御は loopback のままです。専用 Chromium プロファイルで手動ログインします。',
  browserTitle: '専用ブラウザー',
  browserNotRunning: '未実行',
  browserExternal: '外部ウィンドウ',
  browserDocked: 'ドッキング済み',
  browserPane: 'ブラウザーペイン',
  browserPlaceholder: 'サービスを開始して専用 ChatGPT ウィンドウを開きます。',
  settingsTitle: '設定',
  language: '言語',
  automaticLocale: '初回起動時に OS のロケールから言語を選択します。',
  localePrivacyTitle: 'ロケールのプライバシー',
  localePrivacyBody: '言語判定はローカルのみで、IP やロケールを外部へ送信しません。',
  remoteSafetyTitle: 'リモートアクセスの安全性',
  remoteSafetyBody:
    'Cloudflare Access を推奨します。Bearer のみは単一所有者向けの明示的な選択です。',
  close: '閉じる',
};

const ko = {
  ...en,
  appSubtitle: '로컬 브라우저 브리지 컨트롤러',
  settings: '설정',
  checking: '확인 중...',
  stopped: '중지됨',
  starting: '시작 중',
  ready: '준비됨',
  unhealthy: '확인 필요',
  startService: '서비스 시작',
  stopService: '서비스 중지',
  openLogin: '로그인 브라우저 열기',
  refreshStatus: '상태 새로고침',
  openExternally: '외부에서 열기',
  dockBrowser: '브라우저 도킹',
  tunnelTitle: '개인 Cloudflare Tunnel',
  tunnelDisabled: '비활성화',
  tunnelAccess: 'Access 보호',
  tunnelBearer: 'Bearer 전용',
  installCloudflared: 'cloudflared 설치',
  enableAccess: 'Access로 활성화',
  enableBearer: 'Bearer 전용 활성화...',
  disableTunnel: '터널 비활성화',
  openSetupFolder: '설정 폴더 열기',
  guideTitle: 'Cloudflare 설정 안내',
  guideIntro:
    '원격 액세스는 단일 소유자를 위한 선택 기능입니다. 로컬 원본과 브라우저 제어는 항상 loopback에 유지됩니다.',
  guideInstallTitle: '1. cloudflared 설치',
  guideInstallBody:
    '위 버튼으로 Windows Package Manager에서 정확한 Cloudflare.cloudflared 패키지를 설치합니다.',
  guideTunnelTitle: '2. 전용 터널과 DNS 경로 생성',
  guideTunnelBody:
    'Cloudflare Zero Trust에서 tab2api 전용 터널을 만들고 호스트 이름을 http://127.0.0.1:3210으로 연결합니다. DevTools 포트는 노출하지 마세요.',
  guideFilesTitle: '3. 비공개 런타임 파일 배치',
  guideFilesBody:
    'cloudflared-tab2api.yml과 cloudflared-access-probe.yml을 비공개 설정 폴더에 넣습니다. 앱은 자격 증명을 표시하거나 복사하지 않습니다.',
  guideAccessTitle: '4. 전체 호스트 이름을 Access로 보호',
  guideAccessBody:
    '전체 호스트 이름에 Self-hosted Access 앱을 만들고 기본 거부 정책을 사용합니다. MFA 소유자 또는 장치별 Service Auth token만 허용하며 Everyone/Bypass는 금지합니다.',
  guideKeyTitle: '5. 독립적인 tab2api 인증 유지',
  guideKeyBody:
    '각 원격 장치에는 취소 가능한 별도 tab2api client key가 필요합니다. Access는 Authorization bearer key를 대체하지 않습니다.',
  guideActivateTitle: '6. 확인 후 활성화',
  guideActivateBody:
    'Access로 활성화를 선택합니다. 고정 HTTP 418 프로브가 cloudflareaccess.com으로 리디렉션될 때만 계속됩니다.',
  guideBearerTitle: 'Bearer 전용 대안',
  guideBearerBody: '공개 호스트 이름 위험을 명시적으로 수락한 단일 소유자만 사용하세요.',
  privateTitle: '개인정보 보호 설계',
  privateBody:
    'API와 브라우저 제어는 loopback에 유지되고 전용 Chromium 프로필에서 수동 로그인합니다.',
  browserTitle: '전용 브라우저',
  browserNotRunning: '실행 안 됨',
  browserExternal: '외부 창',
  browserDocked: '도킹됨',
  browserPane: '브라우저 창',
  browserPlaceholder: '서비스를 시작해 전용 ChatGPT 창을 엽니다.',
  settingsTitle: '설정',
  language: '언어',
  automaticLocale: '첫 실행 시 운영 체제 로케일에서 언어를 선택합니다.',
  localePrivacyTitle: '로케일 개인정보',
  localePrivacyBody: '언어 감지는 로컬에서만 수행되며 IP나 로케일을 외부로 보내지 않습니다.',
  remoteSafetyTitle: '원격 액세스 안전',
  remoteSafetyBody:
    'Cloudflare Access를 권장합니다. Bearer 전용은 단일 소유자의 명시적 선택입니다.',
  close: '닫기',
};

const es = {
  ...en,
  appSubtitle: 'Controlador del puente de navegador local',
  settings: 'Ajustes',
  checking: 'Comprobando...',
  stopped: 'Detenido',
  starting: 'Iniciando',
  ready: 'Listo',
  unhealthy: 'Requiere atención',
  startService: 'Iniciar servicio',
  stopService: 'Detener servicio',
  openLogin: 'Abrir navegador de acceso',
  refreshStatus: 'Actualizar estado',
  openExternally: 'Abrir externamente',
  dockBrowser: 'Acoplar navegador',
  tunnelTitle: 'Cloudflare Tunnel personal',
  tunnelDisabled: 'Desactivado',
  tunnelAccess: 'Protegido por Access',
  tunnelBearer: 'Solo bearer',
  installCloudflared: 'Instalar cloudflared',
  enableAccess: 'Activar con Access',
  enableBearer: 'Activar solo bearer...',
  disableTunnel: 'Desactivar túnel',
  openSetupFolder: 'Abrir carpeta de configuración',
  guideTitle: 'Guía de configuración de Cloudflare',
  guideIntro:
    'El acceso remoto es opcional y para un único propietario. El origen local y el control del navegador permanecen en loopback.',
  guideInstallTitle: '1. Instalar cloudflared',
  guideInstallBody:
    'Usa el botón superior para instalar el paquete exacto Cloudflare.cloudflared mediante Windows Package Manager.',
  guideTunnelTitle: '2. Crear un túnel y ruta DNS dedicados',
  guideTunnelBody:
    'Crea en Cloudflare Zero Trust un túnel exclusivo para tab2api. Enruta el hostname a http://127.0.0.1:3210. Nunca expongas el puerto DevTools.',
  guideFilesTitle: '3. Colocar los archivos privados',
  guideFilesBody:
    'Coloca cloudflared-tab2api.yml y cloudflared-access-probe.yml en la carpeta privada. La app nunca muestra ni copia credenciales.',
  guideAccessTitle: '4. Proteger todo el hostname con Access',
  guideAccessBody:
    'Crea una aplicación Access Self-hosted para todo el hostname. Usa denegación por defecto y permite solo al propietario con MFA o un token Service Auth por dispositivo. Nunca Everyone ni Bypass.',
  guideKeyTitle: '5. Mantener la autenticación de tab2api',
  guideKeyBody:
    'Cada dispositivo remoto necesita su propia clave tab2api revocable. Access no sustituye el bearer de Authorization.',
  guideActivateTitle: '6. Verificar y activar',
  guideActivateBody:
    'Elige Activar con Access. La app continúa solo si Access redirige la sonda HTTP 418 fija a cloudflareaccess.com.',
  guideBearerTitle: 'Alternativa solo bearer',
  guideBearerBody:
    'Solo para un propietario que acepte explícitamente un hostname público. Las API protegidas siguen requiriendo una clave tab2api.',
  privateTitle: 'Privado por diseño',
  privateBody:
    'La API y el control del navegador permanecen en loopback. El inicio de sesión es manual en un perfil Chromium dedicado.',
  browserTitle: 'Navegador dedicado',
  browserNotRunning: 'No iniciado',
  browserExternal: 'Ventana externa',
  browserDocked: 'Acoplado',
  browserPane: 'Panel del navegador',
  browserPlaceholder: 'Inicia el servicio para abrir la ventana dedicada de ChatGPT.',
  settingsTitle: 'Ajustes',
  language: 'Idioma',
  automaticLocale:
    'En el primer inicio se elige el idioma según la configuración regional del sistema.',
  localePrivacyTitle: 'Privacidad regional',
  localePrivacyBody: 'La detección es local; tab2api no envía tu IP ni configuración regional.',
  remoteSafetyTitle: 'Seguridad del acceso remoto',
  remoteSafetyBody:
    'Se recomienda Cloudflare Access. Solo bearer requiere una elección explícita de propietario único.',
  close: 'Cerrar',
};

const fr = {
  ...en,
  appSubtitle: 'Contrôleur de passerelle navigateur locale',
  settings: 'Paramètres',
  checking: 'Vérification...',
  stopped: 'Arrêté',
  starting: 'Démarrage',
  ready: 'Prêt',
  unhealthy: 'Attention requise',
  startService: 'Démarrer le service',
  stopService: 'Arrêter le service',
  openLogin: 'Ouvrir le navigateur de connexion',
  refreshStatus: 'Actualiser',
  openExternally: 'Ouvrir séparément',
  dockBrowser: 'Ancrer le navigateur',
  tunnelTitle: 'Cloudflare Tunnel personnel',
  tunnelDisabled: 'Désactivé',
  tunnelAccess: 'Protégé par Access',
  tunnelBearer: 'Bearer uniquement',
  installCloudflared: 'Installer cloudflared',
  enableAccess: 'Activer avec Access',
  enableBearer: 'Activer en bearer uniquement...',
  disableTunnel: 'Désactiver le tunnel',
  openSetupFolder: 'Ouvrir le dossier de configuration',
  guideTitle: 'Guide de configuration Cloudflare',
  guideIntro:
    "L'accès distant est facultatif et réservé à un seul propriétaire. L'origine locale et le contrôle du navigateur restent sur loopback.",
  guideInstallTitle: '1. Installer cloudflared',
  guideInstallBody:
    'Utilisez le bouton ci-dessus pour installer le paquet exact Cloudflare.cloudflared via Windows Package Manager.',
  guideTunnelTitle: '2. Créer un tunnel et une route DNS dédiés',
  guideTunnelBody:
    "Dans Cloudflare Zero Trust, créez un tunnel réservé à tab2api. Routez le nom d'hôte vers http://127.0.0.1:3210. N'exposez jamais le port DevTools.",
  guideFilesTitle: '3. Placer les fichiers privés',
  guideFilesBody:
    "Placez cloudflared-tab2api.yml et cloudflared-access-probe.yml dans le dossier privé. L'application n'affiche ni ne copie les identifiants.",
  guideAccessTitle: "4. Protéger tout le nom d'hôte avec Access",
  guideAccessBody:
    "Créez une application Access Self-hosted couvrant tout le nom d'hôte. Refus par défaut, propriétaire avec MFA ou un token Service Auth par appareil. Jamais Everyone ni Bypass.",
  guideKeyTitle: "5. Conserver l'authentification tab2api",
  guideKeyBody:
    'Chaque appareil distant doit utiliser sa propre clé tab2api révocable. Access ne remplace pas le bearer Authorization.',
  guideActivateTitle: '6. Vérifier et activer',
  guideActivateBody:
    "Choisissez Activer avec Access. L'application continue uniquement si Access redirige la sonde HTTP 418 fixe vers cloudflareaccess.com.",
  guideBearerTitle: 'Alternative bearer uniquement',
  guideBearerBody:
    "Uniquement pour un propriétaire acceptant explicitement un nom d'hôte public. Les API protégées exigent toujours une clé tab2api.",
  privateTitle: 'Privé par conception',
  privateBody:
    'API et contrôle du navigateur restent sur loopback. La connexion est manuelle dans un profil Chromium dédié.',
  browserTitle: 'Navigateur dédié',
  browserNotRunning: 'Non démarré',
  browserExternal: 'Fenêtre externe',
  browserDocked: 'Ancré',
  browserPane: 'Volet navigateur',
  browserPlaceholder: 'Démarrez le service pour ouvrir la fenêtre ChatGPT dédiée.',
  settingsTitle: 'Paramètres',
  language: 'Langue',
  automaticLocale:
    "Au premier lancement, la langue suit les paramètres régionaux du système d'exploitation.",
  localePrivacyTitle: 'Confidentialité régionale',
  localePrivacyBody: "La détection est locale : tab2api n'envoie ni votre IP ni votre langue.",
  remoteSafetyTitle: "Sécurité de l'accès distant",
  remoteSafetyBody:
    'Cloudflare Access est recommandé. Le mode bearer uniquement reste un choix explicite pour un propriétaire unique.',
  close: 'Fermer',
};

const de = {
  ...en,
  appSubtitle: 'Lokaler Browser-Bridge-Controller',
  settings: 'Einstellungen',
  checking: 'Wird geprüft...',
  stopped: 'Gestoppt',
  starting: 'Wird gestartet',
  ready: 'Bereit',
  unhealthy: 'Prüfung erforderlich',
  startService: 'Dienst starten',
  stopService: 'Dienst stoppen',
  openLogin: 'Login-Browser öffnen',
  refreshStatus: 'Status aktualisieren',
  openExternally: 'Extern öffnen',
  dockBrowser: 'Browser andocken',
  tunnelTitle: 'Persönlicher Cloudflare Tunnel',
  tunnelDisabled: 'Deaktiviert',
  tunnelAccess: 'Access-geschützt',
  tunnelBearer: 'Nur Bearer',
  installCloudflared: 'cloudflared installieren',
  enableAccess: 'Mit Access aktivieren',
  enableBearer: 'Nur Bearer aktivieren...',
  disableTunnel: 'Tunnel deaktivieren',
  openSetupFolder: 'Setup-Ordner öffnen',
  guideTitle: 'Cloudflare-Einrichtung',
  guideIntro:
    'Remotezugriff ist optional und nur für einen Eigentümer vorgesehen. Lokaler Ursprung und Browsersteuerung bleiben auf Loopback.',
  guideInstallTitle: '1. cloudflared installieren',
  guideInstallBody:
    'Die Schaltfläche installiert das exakte Paket Cloudflare.cloudflared über den Windows Package Manager.',
  guideTunnelTitle: '2. Dedizierten Tunnel und DNS-Route erstellen',
  guideTunnelBody:
    'Erstellen Sie in Cloudflare Zero Trust einen Tunnel nur für tab2api. Leiten Sie den Hostnamen an http://127.0.0.1:3210 weiter. Der DevTools-Port darf nie veröffentlicht werden.',
  guideFilesTitle: '3. Private Laufzeitdateien ablegen',
  guideFilesBody:
    'Legen Sie cloudflared-tab2api.yml und cloudflared-access-probe.yml im privaten Setup-Ordner ab. Die App zeigt oder kopiert keine Zugangsdaten.',
  guideAccessTitle: '4. Gesamten Hostnamen mit Access schützen',
  guideAccessBody:
    'Erstellen Sie eine Self-hosted Access-Anwendung für den gesamten Hostnamen. Standardmäßig ablehnen; nur Eigentümer mit MFA oder je Gerät ein Service-Auth-Token. Niemals Everyone oder Bypass.',
  guideKeyTitle: '5. Separate tab2api-Authentifizierung behalten',
  guideKeyBody:
    'Jedes Remotegerät benötigt einen eigenen widerrufbaren tab2api-Client-Key. Access ersetzt den Authorization-Bearer-Key nicht.',
  guideActivateTitle: '6. Prüfen und aktivieren',
  guideActivateBody:
    'Wählen Sie Mit Access aktivieren. Die App fährt nur fort, wenn Access die feste HTTP-418-Probe zu cloudflareaccess.com umleitet.',
  guideBearerTitle: 'Alternative nur mit Bearer',
  guideBearerBody:
    'Nur für einen Eigentümer, der einen öffentlich erreichbaren Hostnamen ausdrücklich akzeptiert. Geschützte APIs benötigen weiterhin einen tab2api-Key.',
  privateTitle: 'Privat konzipiert',
  privateBody:
    'API und Browsersteuerung bleiben auf Loopback. Die Anmeldung erfolgt manuell in einem eigenen Chromium-Profil.',
  browserTitle: 'Dedizierter Browser',
  browserNotRunning: 'Nicht aktiv',
  browserExternal: 'Externes Fenster',
  browserDocked: 'Angedockt',
  browserPane: 'Browserbereich',
  browserPlaceholder: 'Starten Sie den Dienst, um das eigene ChatGPT-Fenster zu öffnen.',
  settingsTitle: 'Einstellungen',
  language: 'Sprache',
  automaticLocale: 'Beim ersten Start wird die Sprache aus der Betriebssystem-Locale gewählt.',
  localePrivacyTitle: 'Locale-Datenschutz',
  localePrivacyBody:
    'Die Spracherkennung erfolgt lokal; tab2api sendet weder IP-Adresse noch Locale.',
  remoteSafetyTitle: 'Sicherheit des Remotezugriffs',
  remoteSafetyBody:
    'Cloudflare Access wird empfohlen. Nur Bearer bleibt eine ausdrückliche Einzelbesitzer-Option.',
  close: 'Schließen',
};

Object.assign(zh, {
  inspectingService: '正在检查本地 sidecar。',
  loginOpen: '登录浏览器已打开',
  serviceStopped: '本地服务已停止。',
  serviceStarting: '正在启动仅限 loopback 的服务和专用浏览器。',
  serviceReady: '本地 API 和专用浏览器已就绪。',
  serviceUnhealthy: '进程正在运行，但 loopback 健康检查失败。',
  serviceLoginOpen: '启动服务前请关闭手动登录浏览器。',
  inspectingTunnel: '正在检查可选的远程访问。',
  tunnelUnknown: '未知模式',
  tunnelUnsupported: '不支持',
  tunnelRunningAccess: 'Cloudflare Tunnel 正在 Access 保护下运行。',
  tunnelRunningBearer: 'Cloudflare Tunnel 正以单一所有者的仅 Bearer 模式运行。',
  tunnelRunningUnknown: 'Cloudflare Tunnel 正以未知保护模式运行。',
  tunnelInstalledStopped: 'Cloudflare Tunnel 已安装但未运行。',
  tunnelNeedsInstall: '安装 cloudflared 以启用可选的个人远程访问。',
  tunnelNeedsConfig: '激活前需要私有隧道配置。',
  tunnelReady: 'Cloudflare Tunnel 已可启用。',
  tunnelConfig: '隧道配置',
  accessProbe: 'Access 探针',
  prerequisiteReady: '就绪',
  prerequisiteMissing: '缺失',
  browserMeta: '手动配置 · loopback 控制 · 外部窗口回退',
  confirmBearer:
    '仅 Bearer 模式会使主机名公开可访问。仅限单一所有者，并使用独立可撤销的 tab2api client key。Cloudflare Access 更安全。确定启用吗？',
  nativeBridgeError: '本地桥接初始化失败。请重启 tab2api；若问题持续，请重新安装。',
  bridgeUnavailable: '桌面桥接不可用',
  bridgeUnavailableDetail: '此窗口未注入本地命令 API。',
  accessActivationError:
    'Cloudflare Access 未拦截固定探针。请为整个主机名配置 Self-hosted Access 应用后重试。',
  bearerActivationError:
    'Windows 在一次有限重试后仍无法启动仅 Bearer 计划任务。请检查任务计划程序后重试。',
});

Object.assign(ja, {
  inspectingService: 'ローカル sidecar を確認しています。',
  loginOpen: 'ログインブラウザーが開いています',
  serviceStopped: 'ローカルサービスは停止しています。',
  serviceStarting: 'loopback 専用サービスと専用ブラウザーを起動しています。',
  serviceReady: 'ローカル API と専用ブラウザーの準備ができました。',
  serviceUnhealthy: 'プロセスは動作中ですが loopback ヘルスチェックに失敗しました。',
  serviceLoginOpen: 'サービス開始前に手動ログインブラウザーを閉じてください。',
  inspectingTunnel: '任意のリモートアクセスを確認しています。',
  tunnelUnknown: '不明なモード',
  tunnelUnsupported: '未対応',
  tunnelRunningAccess: 'Cloudflare Tunnel は Access 保護付きで動作中です。',
  tunnelRunningBearer: 'Cloudflare Tunnel は単一所有者向け Bearer のみで動作中です。',
  tunnelRunningUnknown: 'Cloudflare Tunnel は不明な保護モードで動作中です。',
  tunnelInstalledStopped: 'Cloudflare Tunnel はインストール済みですが停止中です。',
  tunnelNeedsInstall: '任意の個人リモートアクセスには cloudflared をインストールしてください。',
  tunnelNeedsConfig: '有効化前に非公開トンネル設定が必要です。',
  tunnelReady: 'Cloudflare Tunnel を有効化できます。',
  tunnelConfig: 'トンネル設定',
  accessProbe: 'Access プローブ',
  prerequisiteReady: '準備完了',
  prerequisiteMissing: '不足',
  browserMeta: '手動プロファイル · loopback 制御 · 外部フォールバック',
  confirmBearer:
    'Bearer のみではホスト名が公開されます。単一所有者が個別の取り消し可能な tab2api client key を使う場合のみ続行してください。Access の方が安全です。有効化しますか？',
  nativeBridgeError:
    'ネイティブブリッジの初期化に失敗しました。tab2api を再起動し、続く場合は再インストールしてください。',
  bridgeUnavailable: 'デスクトップブリッジを利用できません',
  bridgeUnavailableDetail: 'このウィンドウにネイティブコマンド API が注入されていません。',
  accessActivationError:
    'Cloudflare Access が固定プローブを遮断しませんでした。ホスト名全体に Self-hosted Access アプリを設定して再試行してください。',
  bearerActivationError:
    'Windows は限定再試行後も Bearer 専用タスクを開始できませんでした。タスクスケジューラを確認して再試行してください。',
});

Object.assign(ko, {
  inspectingService: '로컬 sidecar를 확인하고 있습니다.',
  loginOpen: '로그인 브라우저 열림',
  serviceStopped: '로컬 서비스가 중지되었습니다.',
  serviceStarting: 'loopback 전용 서비스와 전용 브라우저를 시작하고 있습니다.',
  serviceReady: '로컬 API와 전용 브라우저가 준비되었습니다.',
  serviceUnhealthy: '프로세스는 실행 중이지만 loopback 상태 확인에 실패했습니다.',
  serviceLoginOpen: '서비스 시작 전에 수동 로그인 브라우저를 닫으세요.',
  inspectingTunnel: '선택적 원격 액세스를 확인하고 있습니다.',
  tunnelUnknown: '알 수 없는 모드',
  tunnelUnsupported: '지원 안 됨',
  tunnelRunningAccess: 'Cloudflare Tunnel이 Access 보호와 함께 실행 중입니다.',
  tunnelRunningBearer: 'Cloudflare Tunnel이 단일 소유자 Bearer 전용 모드로 실행 중입니다.',
  tunnelRunningUnknown: 'Cloudflare Tunnel이 알 수 없는 보호 모드로 실행 중입니다.',
  tunnelInstalledStopped: 'Cloudflare Tunnel이 설치되었지만 실행 중이 아닙니다.',
  tunnelNeedsInstall: '선택적 개인 원격 액세스를 위해 cloudflared를 설치하세요.',
  tunnelNeedsConfig: '활성화 전에 비공개 터널 설정이 필요합니다.',
  tunnelReady: 'Cloudflare Tunnel을 활성화할 수 있습니다.',
  tunnelConfig: '터널 설정',
  accessProbe: 'Access 프로브',
  prerequisiteReady: '준비됨',
  prerequisiteMissing: '누락',
  browserMeta: '수동 프로필 · loopback 제어 · 외부 대체',
  confirmBearer:
    'Bearer 전용은 호스트 이름을 공개합니다. 단일 소유자와 별도의 취소 가능한 tab2api client key를 사용하는 경우에만 계속하세요. Access가 더 안전합니다. 활성화할까요?',
  nativeBridgeError:
    '네이티브 브리지 초기화에 실패했습니다. tab2api를 다시 시작하고 문제가 계속되면 재설치하세요.',
  bridgeUnavailable: '데스크톱 브리지를 사용할 수 없음',
  bridgeUnavailableDetail: '이 창에 네이티브 명령 API가 주입되지 않았습니다.',
  accessActivationError:
    'Cloudflare Access가 고정 프로브를 차단하지 않았습니다. 전체 호스트 이름에 Self-hosted Access 앱을 설정한 후 다시 시도하세요.',
  bearerActivationError:
    'Windows가 제한된 재시도 후에도 Bearer 전용 예약 작업을 시작하지 못했습니다. 작업 스케줄러를 확인하고 다시 시도하세요.',
});

Object.assign(es, {
  inspectingService: 'Comprobando el sidecar local.',
  loginOpen: 'Navegador de acceso abierto',
  serviceStopped: 'El servicio local está detenido.',
  serviceStarting: 'Iniciando el servicio limitado a loopback y el navegador dedicado.',
  serviceReady: 'La API local y el navegador dedicado están listos.',
  serviceUnhealthy: 'El proceso está activo, pero falló la comprobación de loopback.',
  serviceLoginOpen: 'Cierra el navegador de acceso manual antes de iniciar el servicio.',
  inspectingTunnel: 'Comprobando el acceso remoto opcional.',
  tunnelUnknown: 'Modo desconocido',
  tunnelUnsupported: 'No compatible',
  tunnelRunningAccess: 'Cloudflare Tunnel funciona con protección de Access.',
  tunnelRunningBearer: 'Cloudflare Tunnel funciona en modo solo bearer para un único propietario.',
  tunnelRunningUnknown: 'Cloudflare Tunnel funciona con un modo de protección desconocido.',
  tunnelInstalledStopped: 'Cloudflare Tunnel está instalado, pero no está activo.',
  tunnelNeedsInstall: 'Instala cloudflared para activar el acceso remoto personal opcional.',
  tunnelNeedsConfig: 'Se requiere la configuración privada del túnel antes de activarlo.',
  tunnelReady: 'Cloudflare Tunnel está listo para activarse.',
  tunnelConfig: 'configuración del túnel',
  accessProbe: 'sonda Access',
  prerequisiteReady: 'listo',
  prerequisiteMissing: 'falta',
  browserMeta: 'Perfil manual · control loopback · alternativa externa',
  confirmBearer:
    'Solo bearer hace público el hostname. Continúa únicamente para un propietario y con una clave tab2api independiente y revocable. Access es más seguro. ¿Activar?',
  nativeBridgeError:
    'Falló la inicialización del puente nativo. Reinicia tab2api; reinstala la app si persiste.',
  bridgeUnavailable: 'Puente de escritorio no disponible',
  bridgeUnavailableDetail: 'La API de comandos nativos no se inyectó en esta ventana.',
  accessActivationError:
    'Cloudflare Access no interceptó la sonda fija. Configura una aplicación Access Self-hosted para todo el hostname y vuelve a intentarlo.',
  bearerActivationError:
    'Windows no pudo iniciar la tarea programada solo bearer tras un reintento limitado. Comprueba el Programador de tareas y reintenta.',
});

Object.assign(fr, {
  inspectingService: 'Vérification du sidecar local.',
  loginOpen: 'Navigateur de connexion ouvert',
  serviceStopped: 'Le service local est arrêté.',
  serviceStarting: 'Démarrage du service limité à loopback et du navigateur dédié.',
  serviceReady: "L'API locale et le navigateur dédié sont prêts.",
  serviceUnhealthy: 'Le processus fonctionne, mais le contrôle loopback a échoué.',
  serviceLoginOpen: 'Fermez le navigateur de connexion manuelle avant de démarrer le service.',
  inspectingTunnel: "Vérification de l'accès distant facultatif.",
  tunnelUnknown: 'Mode inconnu',
  tunnelUnsupported: 'Non pris en charge',
  tunnelRunningAccess: 'Cloudflare Tunnel fonctionne avec la protection Access.',
  tunnelRunningBearer:
    'Cloudflare Tunnel fonctionne en mode bearer uniquement pour un propriétaire.',
  tunnelRunningUnknown: 'Cloudflare Tunnel fonctionne avec un mode de protection inconnu.',
  tunnelInstalledStopped: "Cloudflare Tunnel est installé mais n'est pas actif.",
  tunnelNeedsInstall: "Installez cloudflared pour activer l'accès distant personnel facultatif.",
  tunnelNeedsConfig: "La configuration privée du tunnel est requise avant l'activation.",
  tunnelReady: 'Cloudflare Tunnel est prêt à être activé.',
  tunnelConfig: 'configuration du tunnel',
  accessProbe: 'sonde Access',
  prerequisiteReady: 'prêt',
  prerequisiteMissing: 'manquant',
  browserMeta: 'Profil manuel · contrôle loopback · repli externe',
  confirmBearer:
    "Le mode bearer uniquement rend le nom d'hôte public. Continuez seulement pour un propriétaire avec une clé tab2api indépendante et révocable. Access est plus sûr. Activer ?",
  nativeBridgeError:
    "Échec de l'initialisation de la passerelle native. Redémarrez tab2api ; réinstallez si le problème persiste.",
  bridgeUnavailable: 'Passerelle de bureau indisponible',
  bridgeUnavailableDetail: "L'API de commandes natives n'a pas été injectée dans cette fenêtre.",
  accessActivationError:
    "Cloudflare Access n'a pas intercepté la sonde fixe. Configurez une application Access Self-hosted pour tout le nom d'hôte puis réessayez.",
  bearerActivationError:
    "Windows n'a pas pu démarrer la tâche planifiée bearer après une nouvelle tentative limitée. Vérifiez le Planificateur de tâches puis réessayez.",
});

Object.assign(de, {
  inspectingService: 'Der lokale Sidecar wird geprüft.',
  loginOpen: 'Login-Browser geöffnet',
  serviceStopped: 'Der lokale Dienst ist gestoppt.',
  serviceStarting: 'Loopback-Dienst und dedizierter Browser werden gestartet.',
  serviceReady: 'Lokale API und dedizierter Browser sind bereit.',
  serviceUnhealthy: 'Der Prozess läuft, aber die Loopback-Prüfung ist fehlgeschlagen.',
  serviceLoginOpen: 'Schließen Sie vor dem Dienststart den manuellen Login-Browser.',
  inspectingTunnel: 'Optionaler Remotezugriff wird geprüft.',
  tunnelUnknown: 'Unbekannter Modus',
  tunnelUnsupported: 'Nicht unterstützt',
  tunnelRunningAccess: 'Cloudflare Tunnel läuft mit Access-Schutz.',
  tunnelRunningBearer: 'Cloudflare Tunnel läuft im Einzelbesitzer-Modus nur mit Bearer.',
  tunnelRunningUnknown: 'Cloudflare Tunnel läuft mit unbekanntem Schutzmodus.',
  tunnelInstalledStopped: 'Cloudflare Tunnel ist installiert, läuft aber nicht.',
  tunnelNeedsInstall: 'Installieren Sie cloudflared für optionalen persönlichen Remotezugriff.',
  tunnelNeedsConfig: 'Vor der Aktivierung ist eine private Tunnelkonfiguration erforderlich.',
  tunnelReady: 'Cloudflare Tunnel kann aktiviert werden.',
  tunnelConfig: 'Tunnelkonfiguration',
  accessProbe: 'Access-Prüfung',
  prerequisiteReady: 'bereit',
  prerequisiteMissing: 'fehlt',
  browserMeta: 'Manuelles Profil · Loopback-Steuerung · externer Rückfall',
  confirmBearer:
    'Nur Bearer macht den Hostnamen öffentlich erreichbar. Nur für einen Eigentümer mit separatem widerrufbarem tab2api-Client-Key fortfahren. Access ist sicherer. Aktivieren?',
  nativeBridgeError:
    'Initialisierung der nativen Bridge fehlgeschlagen. Starten Sie tab2api neu; installieren Sie die App bei Bedarf erneut.',
  bridgeUnavailable: 'Desktop-Bridge nicht verfügbar',
  bridgeUnavailableDetail: 'Die native Befehls-API wurde nicht in dieses Fenster eingebunden.',
  accessActivationError:
    'Cloudflare Access hat die feste Prüfung nicht abgefangen. Richten Sie eine Self-hosted Access-Anwendung für den gesamten Hostnamen ein und versuchen Sie es erneut.',
  bearerActivationError:
    'Windows konnte die geplante Bearer-Aufgabe nach einem begrenzten Wiederholungsversuch nicht starten. Prüfen Sie die Aufgabenplanung und versuchen Sie es erneut.',
});

export const messages = { en, vi, zh, ja, ko, es, fr, de };

export function detectLanguage(locales = []) {
  for (const locale of locales) {
    const normalized = String(locale).trim().toLowerCase();
    if (!normalized) continue;
    const exact = languageOptions.find(([code]) => code.toLowerCase() === normalized)?.[0];
    if (exact) return exact;
    const base = normalized.split(/[-_]/, 1)[0];
    if (base && Object.hasOwn(messages, base)) return base;
  }
  return 'en';
}

export function loadLanguage(storage, locales = []) {
  try {
    const saved = storage?.getItem('tab2api.language');
    if (saved && Object.hasOwn(messages, saved)) return saved;
  } catch {
    // A locked-down WebView may disable storage; locale detection remains available.
  }
  return detectLanguage(locales);
}

export function saveLanguage(storage, language) {
  if (!Object.hasOwn(messages, language)) return false;
  try {
    storage?.setItem('tab2api.language', language);
    return true;
  } catch {
    return false;
  }
}

export function translate(language, key) {
  return messages[language]?.[key] ?? en[key] ?? key;
}
