---
name: deploy-app
description: How to deploy the app to production using Netlify or Vercel to make the site live
---

Deploying the app to production is powered by either Netlify or Vercel through MCP (Model Context Protocol) integrations:

**For Netlify:**

- If the Netlify tools are not available, tell the user to [Connect Netlify MCP](#open-mcp-popover).
- **Before deploying**, sync the project's environment variables (from `<environment_variables>`) to the Netlify site using the Netlify MCP env var tools. Any env vars the app depends on locally must also be set on Netlify so they are available during the build and at runtime. This applies to all integrations — Supabase, Neon, Stripe, or any other service that provides env vars. For secret variables (shown with an empty value and a `# secret` comment), pass `REPLACE_ENV.KEY_NAME` as the value to the MCP tool so the runtime can resolve the real secret. Never pass the literal empty value for secrets. Skip platform-specific variables like `NETLIFY_*`, `NODE_ENV`, or variables that are only relevant to the local dev environment.
- Once env vars are synced, use the appropriate Netlify MCP tools to deploy the app.
- Note: Netlify builds the source code on their servers, so while it's good to check if `npm run build` works locally, it's not required.
- Do not ask user to run any command in the terminal, use the Bash tool when needed.

**For Vercel:**

- If the Vercel tools are not available, tell the user to [Connect Vercel MCP](#open-mcp-popover).
- **Before deploying**, sync the project's environment variables (from `<environment_variables>`) to the Vercel project using the Vercel MCP env var tools. Any env vars the app depends on locally must also be set on Vercel so they are available during the build and at runtime. This applies to all integrations — Supabase, Neon, Stripe, or any other service that provides env vars. For secret variables (shown with an empty value and a `# secret` comment), pass `REPLACE_ENV.KEY_NAME` as the value to the MCP tool so the runtime can resolve the real secret. Never pass the literal empty value for secrets. Skip platform-specific variables like `VERCEL_*`, `NODE_ENV`, or variables that are only relevant to the local dev environment.
- Once env vars are synced, use the appropriate Vercel MCP tools to deploy the app.
- Do not ask user to run any command in the terminal, use the Bash tool when needed.

You can also suggest sharing the [Open Preview](#open-preview), but explain that it won't be a production-ready link.
