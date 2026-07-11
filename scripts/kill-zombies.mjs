import { execSync } from "node:child_process";

const currentPid = process.pid;

try {
  // Retrieve list of node/python processes with their command lines from WMI/CIM
  const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe' or Name = 'python.exe' or Name = 'pythonw.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"`;
  const output = execSync(cmd, { encoding: "utf8" }).trim();
  
  if (!output) {
    console.log("No node or python processes found.");
    process.exit(0);
  }

  // Handle single object vs array from ConvertTo-Json
  let processes = [];
  if (output.startsWith("[")) {
    processes = JSON.parse(output);
  } else if (output.startsWith("{")) {
    processes = [JSON.parse(output)];
  }

  console.log(`Analyzing ${processes.length} running processes...`);
  let killedCount = 0;

  for (const proc of processes) {
    const pid = proc.ProcessId;
    const cmdLine = proc.CommandLine || "";

    // Skip current process
    if (pid === currentPid) continue;

    // Check if the command line contains project identifiers and is not our scripts
    const isTarget = 
      cmdLine.includes("Mimir") ||
      cmdLine.includes("trading_engine.mjs") ||
      cmdLine.includes("api_server.mjs") ||
      cmdLine.includes("start:engine") ||
      cmdLine.includes("start:api");

    if (isTarget && !cmdLine.includes("kill-zombies.mjs") && !cmdLine.includes("list-processes.mjs")) {
      console.log(`Killing process [PID ${pid}] executing: ${cmdLine.substring(0, 120)}...`);
      try {
        // Use taskkill on Windows — process.kill(pid, "SIGKILL") silently fails on Windows
        execSync(`taskkill /f /t /pid ${pid}`, { stdio: "ignore" });
        killedCount++;
      } catch (err) {
        console.error(`Failed to kill PID ${pid}: ${err.message}`);
      }
    }
  }

  console.log(`Cleanup complete. Stopped ${killedCount} matching process(es).`);
} catch (err) {
  console.error("Error executing process cleanup script:", err.message);
  process.exit(1);
}
