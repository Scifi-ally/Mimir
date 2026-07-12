# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
