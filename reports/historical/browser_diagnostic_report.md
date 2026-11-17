# Chrome connectivity diagnostic

Recorded 2026-11-17T14:50:54.691Z. Job research remains paused. Existing database preserved: 365 vacancies, 0 confirmed submissions.

## Findings

- All four hosts resolve via DNS. Direct Node HTTPS requests fail with EACCES; curl to Google also fails connecting to port 443. This establishes an access restriction outside the page-load waiting logic. It does not identify a specific firewall rule.
- User confirms normal Chrome Profile 4 can load Google and Microsoft Careers. Websites are not declared unavailable.
- WinHTTP direct; WinINET ProxyEnable=0, ProxyServer=null, AutoConfigURL=null; no proxy environment variables found.
- netsh reports all profiles enabled with BlockInbound,AllowOutbound. Specific rule inspection through Get-NetFirewallProfile denied. No firewall settings changed.
- Playwright-controlled Chrome 157.0.8103.79 launches. Tests use waitUntil=commit (10 seconds), avoiding dependency on slow images/analytics or DOM completion. No HTTP response or visible site content was obtained. Browser navigation failures are ERR_ABORTED, sometimes emitted on closing the timed-out page; do not treat that as the original cause. No page console errors were captured because no page loaded.
- Actual launch arguments could not be retrieved through CDP (enable-automation not set). Configured launch uses the Chrome executable and headless mode, without custom networking or security flags.
- Standalone Chrome CLI without Playwright exited 2147483651, with GPU-process failures. This is not a successful direct-browsing control; the successful normal-desktop comparison is user-observed. No GPU sandbox/security settings were disabled.

## Sequential validation

| Website | Chrome launch | Navigation | Final URL | Title observed | HTTP / network error | Visible content |
|---|---|---|---|---|---|---|
| https://www.google.com | Success | Failed | about:blank | Loading https://www.google.com/ (not a site title) | No HTTP response; HTTPS EACCES; navigation timeout | No |
| https://careers.microsoft.com/ | Success | Failed | about:blank | Loading https://careers.microsoft.com/ (not a site title) | No HTTP response; HTTPS EACCES; navigation timeout | No |
| https://www.amazon.jobs/ | Success | Failed | about:blank | Loading https://www.amazon.jobs/ (not a site title) | No HTTP response; HTTPS EACCES; navigation timeout | No |
| https://www.bmwgroup.jobs/ | Success | Failed | about:blank | Loading https://www.bmwgroup.jobs/ (not a site title) | No HTTP response; HTTPS EACCES; navigation timeout | No |

## Extension connection

Profile 4 contains Playwright CRX 0.15.0, ID jambeljnbnfbkcpnoiaedcabbgmnnlcd. Its documented API operates inside an extension using chrome.debugger; its recorder banner does not prove that a Node/MCP client can attach. The current MCP expects the distinct Playwright Extension, ID mmlmfjhmonkocbjadbfplnigmagldckm, and reports it missing. No documented direct attachment of this MCP to the installed CRX recorder was found.

Supported MCP configuration is prepared in playwright-mcp.chrome.json, explicitly selecting Profile 4. It is a project-local configuration, not applied to the running app/server. The user must install/enable the [official Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) in Profile 4 and reconnect the MCP with that configuration through the host client. No personal profile changes were performed automatically. Do not copy credentials. If using dedicated automation instead, its execution environment needs permitted outbound HTTPS; retry only after that external condition changes.

References: [Playwright MCP connection documentation](https://playwright.dev/mcp/configuration/browser-extension), [Playwright CRX maintained documentation](https://github.com/ruifigueira/playwright-crx).

## Application test

Not attempted: Microsoft Careers has no successful browser navigation. No requirements/form extraction, form filling or submission is claimed. Resume existing applications only after connectivity validation succeeds.
