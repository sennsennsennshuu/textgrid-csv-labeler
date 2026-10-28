# TextGrid / CSV Labeler

Windows 单文件标注工具。双击 **textgrid-csv-labeler.exe** 即可运行，界面与网页版完全相同，音频和标注不上传云端。

## 下载与运行

从本仓库 Releases 下载 textgrid-csv-labeler.exe。将它放在任意可读目录直接运行，不需要安装，不需要把 HTML、DLL、配置、音频示例或资源目录放在旁边。

运行要求：Windows 10/11 x64，已安装 Microsoft Edge。程序使用系统 Edge 的独立应用窗口（没有地址栏）显示内嵌页面；不是把线上网站打开后再使用。Edge 自身可能按其浏览器机制维护用户配置和缓存，这些属于系统浏览器数据；程序不向交付目录解压任何文件。

本版本未进行代码签名，Windows 的首次下载/运行提示由系统处理。未附带安装器、自动更新器或第三方捆绑内容。

## 功能

- 同网页的默认暗色、明暗切换、响应式布局、主站图标与备案页脚。
- 打开音频、TextGrid、CSV 文件或文件夹；支持拖放和同名配对；WAV / FLAC / MP3 由原网页同一路径解码。
- 波形、频谱和多层标注同步显示；查看/编辑切换，精确起终点、边界拖动、吸附、联动、分割/删除、层管理及撤销。
- CSV 一级/二级列表，以及 ph_seq → ph_dur → ph_num 三层时序；ph_dur 文本或边界修改自动联动，CSV 与 TextGrid 独立历史。
- 本地音素表检测，显示错误的时间区间，排除 AP/SP/EP/GS/VF 附加音素。
- 右上角保存全部未保存数据，覆盖用户授权的原始 CSV / TextGrid；不弹出浏览器下载。
- Ctrl+S 确认保存，Ctrl+Shift+S 直接保存；应用修改只提交当前编辑。
- Space 播放/停止，Ctrl+Space 播放框选范围或当前选中区间，Shift+C 新增点/分割，Tab 查看/编辑。
- Ctrl+滚轮横向缩放、Shift+滚轮横向滚动、Ctrl+Shift+滚轮按波形/频谱区域纵向缩放，波形上限 12×。
- 修改时长后只保留当前标注条目选中；播放停止/自然结束按“回到播放开始时”或“不动”同步指针与时钟。
- 关闭窗口沿用网页未保存提示，确认关闭后本地 Rust 服务退出。

首次保存时，若文件来自传统 input/拖放且没有可写句柄，会要求重新选择同一个原文件授权写入；这是原网页的同一行为。

## 架构与本地处理

Rust 标准库程序直接内嵌 ui/textgrid.html，通过只监听 127.0.0.1 的服务提供页面。默认端口 38727 用于跨次启动保持浏览器主题偏好；端口冲突时自动选择空闲端口。每次启动生成 BCryptGenRandom 的 256 位随机能力路径，检查精确 Host/Origin，拒绝非空 HTTP 请求体和文件上传。

页面没有外部资源依赖，不读取线上版本；原始 HTML/CSS/JavaScript 保持原样，只额外加入空请求的窗口生命周期通知。音频、File/Blob、标注和编辑历史均不经过 Rust 服务。没有自动载入或提供示例音频。

正常关闭窗口，Rust 约 3 秒退出；刷新由新页面通知取消退出；浏览器异常崩溃或强制结束时，服务在最后一次心跳 240 秒后退出。程序未打开局域网端口。

为了保留原网页的 File System Access、音频解码、Worker 频谱与键盘交互，本程序复用系统 Edge，不单独打包一份浏览器运行时。Rust 原生入口、服务、随机令牌和生命周期在 src/main.rs；界面与 DSP/标注逻辑在 web/src。

## 本地重建

需要 Rust MSVC 工具链（本次构建 rustc 1.95.0）、Windows C++ Build Tools。

在仓库根目录运行：

    powershell -ExecutionPolicy Bypass -File .\build.ps1

脚本使用 rustc 直接构建，静态链接 CRT；只输出 textgrid-csv-labeler.exe，不创建 target、PDB、安装器或 sidecar。源码网页使用 .gitattributes 禁止行尾转换，保证内嵌快照一致。

也可使用 cargo build --release；这种开发构建会按 Cargo 惯例创建 target，交付时只取 EXE。本仓库的单文件交付使用 build.ps1。

重建网页仅开发时需要 Node.js。日常 Rust 构建直接嵌入已验收的 ui/textgrid.html。

    cd web
    npm ci --registry=https://registry.npmmirror.com
    npm run build

修改网页后重新计算 ui/textgrid.html 的 SHA-256，并更新 src/main.rs 的 PAGE_SHA256 再发布；不要混用旧的摘要和新网页。

## 诊断与专项测试

    .\textgrid-csv-labeler.exe --self-test
    .\textgrid-csv-labeler.exe --version
    .\textgrid-csv-labeler.exe --print-html
    .\textgrid-csv-labeler.exe --serve 0

--print-html 输出内嵌正式网页原始字节；--serve 0 启动只读测试服务并输出随机回环地址，不自动打开窗口，测试者需结束进程。

测试脚本统一在 test/，以 test_ 开头：

    npm install --registry=https://registry.npmmirror.com
    npm test

test/test_desktop.mjs 验证内嵌字节一致、HTTP 边界、安全上下文、文件 API、明暗/窄屏、真实 WAV/DSP、CSV、时长修改、Ctrl+Space 和全部脏数据覆盖保存。保存测试只替换系统文件选择器与可写句柄，不覆盖用户磁盘文件，也不声称做了用户数据的真实磁盘覆盖测试。可用 PLAYWRIGHT_EDGE_EXECUTABLE 指定 Edge 路径。

本次没有运行网页项目的无关全量测试。现场版本、实际原生窗口验收和界面像素一致性记录见 docs/VALIDATION.json。

## 来源与发布范围

前端以 2026-10-28 已验收网页版为基础；ui/textgrid.html SHA-256：

    7398246de2deb957ac05853ff8c93c9051d22ed7b6dde8b77f333c38d1c15ce0

设计参考 vlabeler 与 vlabeler-textgrid 的交互理念，本项目没有打包它们的 JVM/桌面运行时。所有发布源码仅包含该标注工具，不包含网站凭据、其他工具、用户音频或标注。

源码在本仓库，编译好的唯一交付文件在 Releases。本项目暂未声明额外开源许可。
