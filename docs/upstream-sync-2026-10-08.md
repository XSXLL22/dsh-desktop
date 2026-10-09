# BISHENG upstream/main 同步（2026-10-08）

合并基线：BISHENG `74ea166`，上游 DSH Desktop `cbb22e4`。Harness 从 `0.1.7-rc.2` 升级到 `0.2.0-rc.2`；应用版本继续为 `1.0.1`，本次同步不触发发布。

## 加载与产品边界

- 后端和客户端继续使用同一 Profile / 安装包解析归属。安装包内的 JS 从当前 `app.asar` 读取，OS 执行的原生文件从 `app.asar.unpacked` 读取；移除只为独立 Node 维护的旧 runtime root 适配。
- Windows / Linux 用 Electron Node mode 启动 Harness；macOS Harness 保留 utility process，包管理子进程使用当前 Electron Helper。企业 broker capability 仍从安装子进程环境剥离。
- 普通 Profile 保留 generation 投影、宿主 peer fallback、本地链接及原始错误诊断；Safe Mode 保留独立 Profile 和安装包 anchor。引导队列、bootstrap 注册与模块图顺序沿用上游。
- 保留 BISHENG app ID、登录协议、数据目录、独立端口、企业登录、企业插件来源标记、社区插件禁用和 ModelScope 更新渠道。新增的官方 Plugin Manager backend 和工作台安装入口补齐相同企业准入限制；卸载、停用和宿主包开关仍可执行。
- 接入 Office 离线 Python、工作台（默认关闭）、安装状态识别和新 Windows caption menu；新宿主包加入企业策略保护集合。BISHENG 不自动导入其他 Harness 产品的数据。

## 补丁生命周期

采用上游 0.2.0-rc.2 的精简补丁集，移除旧 0.1.x 文件。官方已有的扩展点及已移除流程不继续保留旧 model-selection、agent-presets、directory-picker-native、sidebar-documentpreview、sidebar-right、layout 等补丁。保留上游仍需的 Desktop 接缝和兼容补丁。

BISHENG 定制仅在新版本重放：Harness manifest 的企业宿主依赖、欢迎页中英文文案、侧栏品牌容器稳定标记。品牌隐藏样式由宿主 UI 插件持有，不删除或重复挂载公共 slot。移除依赖旧 Windows header 标记及旧 CSS 形状的过时测试。

## 发布边界与验证

保留 BISHENG 的独立 Intel runner、共享 keychain lease 和 draft Release / ModelScope 分发方式。上游的 resign / smoke dispatch 及另一套 signed-test 通知渠道不替换现有 BISHENG 发布协议；Windows smoke 已迁移为实际 Electron Node / ASAR 路径。afterPack 使用上游 ASAR、PPT 和 Office 组合检查。

合并验证要求：干净 npm ci（含全部补丁）、typecheck、build、完整 npm test、git diff --check；另检查原生 macOS 开发安装包。源码测试与打包资源检查不能替代 Windows 原生运行、正式签名/公证、真实企业登录及市场安装验收；这些状态须在交付中单独列出。

实际本地结果：干净 npm ci 全部补丁成功，typecheck、build、npm test（210 文件 / 1765 测试）和 diff 检查通过。darwin/arm64 verify-target 通过，未签名 BISHENG Dev.app 的 afterPack 通过 ASAR、PPT 及 Office 检查；实际包内 Python 完成 DOCX/PPTX/XLSX 创作、结构检查和 PDF 转换。当前包内 Electron Helper 的 node-pty 能启动 shell；临时 Safe Mode Profile 在中立 cwd 下从 app.asar 启动，认证后 bootstrap 返回 200 并注册模块，还成功创建会话/加载 preset，无 profiles/node_modules。启动 stderr 仅观察到环境 SOCKS 代理不支持提示及 fs.Stats deprecation 警告。

Tabbit 返回 BROWSER_RUNTIME_UNAVAILABLE，未完成真实浏览器模块系统创建及 UI 挂载验收。Windows、Intel macOS、正式签名/公证、真实企业登录和安装包内企业市场流程仍待验收。
