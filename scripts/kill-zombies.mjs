import { execSync, execFileSync } from "node:child_process";

const currentPid = process.pid;
let killedCount = 0;
const killedPids = new Set();

function killPid(pid, reason) {
  if (!pid || pid <= 0 || pid === currentPid || killedPids.has(pid)) return;
  console.log(`Killing ${reason} [PID ${pid}]...`);
  try {
    execSync(`taskkill /f /t /pid ${pid}`, { stdio: "ignore" });
    killedPids.add(pid);
    killedCount++;
  } catch (err) {
    // Process might already be dead or exiting
  }
}

try {
  // 1. First, check all known Mimir ports (5000: Backend, 8001: AI Service, 3000: Frontend, 5433: PostgreSQL)
  const ports = [5000, 8001, 3000, 5433];
  for (const port of ports) {
    try {
      const netstatOut = execSync(`netstat -ano | findstr /C:":${port}" | findstr /C:"LISTENING"`, { encoding: "utf8" });
      const lines = netstatOut.split("\n").map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 5) {
          const pid = parseInt(parts[4], 10);
          if (!isNaN(pid) && pid > 0) {
            killPid(pid, `process listening on port ${port}`);
          }
        }
      }
    } catch {
      // No listening process on this port
    }
  }

  // 2. Next, scan all node/python/cloudflared/redis processes by command line string
  try {
    const psCommand = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe' or Name = 'python.exe' or Name = 'pythonw.exe' or Name = 'cloudflared.exe' or Name = 'redis-server.exe'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
    const output = execFileSync("powershell", ["-NoProfile", "-Command", psCommand], { encoding: "utf8" }).trim();
    
    if (output && output !== "") {
      let processes = [];
      if (output.startsWith("[")) {
        processes = JSON.parse(output);
      } else if (output.startsWith("{")) {
        processes = [JSON.parse(output)];
      }

      for (const proc of processes) {
        const pid = proc.ProcessId;
        const cmdLine = proc.CommandLine || "";

        if (pid === currentPid || killedPids.has(pid)) continue;

        // Never kill active MCP servers or diagnostic tools
        if (cmdLine.includes("chrome-devtools-mcp") || cmdLine.includes("mcp-remote")) continue;

        // Check target keywords that indicate a Mimir bot or AI instance
        const isTarget = 
          cmdLine.includes("Mimir") ||
          cmdLine.includes("index.mjs") ||
          cmdLine.includes("main.py") ||
          cmdLine.includes("ai_service") ||
          cmdLine.includes("vite.js") ||
          cmdLine.includes("vite preview") ||
          cmdLine.includes("trading_engine.mjs") ||
          cmdLine.includes("api_server.mjs") ||
          cmdLine.includes("cloudflared") ||
          cmdLine.includes("start:engine") ||
          cmdLine.includes("start:api") ||
          cmdLine.includes("run-detached.ps1");

        if (isTarget && !cmdLine.includes("kill-zombies.mjs") && !cmdLine.includes("list-processes.mjs")) {
          killPid(pid, `process executing (${cmdLine.substring(0, 100)})`);
        }
      }
    }
  } catch (err) {
    // Ignore Get-CimInstance errors if no processes match
  }

  console.log(`Cleanup complete. Stopped ${killedCount} matching process(es).`);
} catch (err) {
  console.error("Error executing process cleanup script:", err.message);
  process.exit(1);
}

