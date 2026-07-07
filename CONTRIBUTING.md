# Contributing to Mimir

First off, thank you for considering contributing to **Mimir**! It is people like you that make Mimir such a powerful, institutional-grade Indian stock market monitoring and automated trading analysis platform.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). Please report any unacceptable behavior to the project maintainers.

---

## How Can I Contribute?

### 1. Reporting Bugs
This section guides you through submitting a bug report for Mimir.
* **Ensure the bug was not already reported** by searching on GitHub under Issues.
* If you're unable to find an open issue addressing the problem, open a new one. Be sure to include a **title and clear description**, as much relevant information as possible, and a **code sample or an executable test case** demonstrating the expected behavior that is not occurring.
* For WebSocket or live telemetry issues, please include your network environment details and whether you are running via Docker or native Node/Python.

### 2. Suggesting Enhancements
* Open an Issue with a tag `[Feature Request]`.
* Explain the quantitative alpha factor, technical indicator, or UI capability you would like to see added.
* Provide details on the institutional trading rationale or performance benefits behind the suggestion.

### 3. Submitting Pull Requests
1. **Fork the Repository** and create your branch from `master`:
   ```bash
   git checkout -b feature/amazing-alpha-factor
   ```
2. **Setup Local Environment**:
   ```bash
   npm install
   npm --prefix backend install --legacy-peer-deps
   pip install -r backend/ai_service/requirements.txt
   ```
3. **Verify Code Quality**:
   Ensure all TypeScript type checks and linting pass before committing:
   ```bash
   npm run typecheck
   npm test
   ```
4. **Commit Your Changes**:
   Write clean, descriptive commit messages:
   ```bash
   git commit -m "feat(ai): implement Hurst exponent market regime classification"
   ```
5. **Push to the Branch** and open a Pull Request!

---

## Architecture & Development Guidelines

### Decoupled Multi-Process Design
When adding new functionality, keep in mind Mimir's separation of concerns:
* **Express Backend (`/backend`)**: Keep I/O non-blocking. Do not perform heavy synchronous number crunching here; delegate numerical analysis to the AI Service.
* **FastAPI AI Service (`/backend/ai_service`)**: Focus on vector operations, numpy/pandas calculations, and AI model evaluation.
* **React Frontend (`/frontend`)**: Maintain 60fps rendering performance. Use custom canvas or memoized components when rendering high-frequency tick streams or real-time order books.

### Security & Telemetry Standards
* **Never commit API keys or `.env` files.** All Upstox OAuth tokens and secrets must be dynamically pulled from environment variables.
* **Respect Rate Limits.** Ensure any new market data endpoints adhere to our token-bucket rate limiting standards (120 req/min).
* **Audit Logging.** Any automated order execution or paper trading state change must be logged to the PostgreSQL audit trail.

Thank you for contributing to Mimir!
