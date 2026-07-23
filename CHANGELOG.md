# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-23

### Added
- **Custom Watchlists**: Seamless command-palette integration for dynamic on-the-fly manual symbol monitoring.
- **Dynamic Island UI**: Seamless status updates, toast notifications, and event streams decoupled from the primary charting interface.
- **Developer Experience**: Standardized `Makefile` and Dependabot workflows for automated dependency management.

### Changed
- **Adaptive Layout Modes**: Flexible and customizable UI layouts to focus purely on signals, charting, or complete terminal views.
- **Pure Digital Scanner**: Visually stunning digital display during overnight scan jobs.
- **Performance optimizations**: Brutal backend architectural cleanup resulting in zero circular dependencies and leaner code.

### Fixed
- **Mobile Responsiveness**: Fixed TopBar horizontal scroll cut-off due to justify alignment bugs on Safari/Chrome.
- **View Transition Engine**: Hardened the dark/light mode animation by scaling viewport coordinates to percentages, bypassing mobile UI layout scaling offsets.
- **PWA Service Worker**: Addressed aggressive caching issues to ensure instantaneous background app updates.

## [1.0.0] - 2026-07-12

### Added
- **Intelligent Load Balancing**: Deterministic round-robin load balancing for Upstox V2/V3 APIs.
- **Custom Screener Engine**: Interactive rule builder and background scanning worker pool.
- **Advanced UI Dashboard**: TradingView lightweight-charts with EMA, VWAP, Support/Resistance zones, and price projection overlays.
- **Paper Trading Engine**: Test quantitative strategies in live market conditions.
- **Divergence Engine**: Automated detection of RSI and MACD divergences against price action.
- **Institutional Order Flow Tracking**: Deep evaluation of institutional accumulation and distribution phases.

### Changed
- **Documentation**: Revamped README and CONTRIBUTING guidelines to an industrial standard.
- **Backend Architecture**: Decoupled monolithic routes, optimized frontend websocket store, and stabilized database pools.
- **CI/CD**: Optimized Docker workflows and GitHub Actions pipelines.

### Fixed
- **Security**: Patched authentication bypasses, secured websocket payloads, and enforced rate limits.
- **Data Integrity**: Used decimal.js for financial math in paper engine to avoid precision drift.
- **Bug Fixes**: Resolved AI target zooming out bug and Python pydantic validation errors.
