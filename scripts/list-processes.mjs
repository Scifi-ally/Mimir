import { execSync } from "node:child_process";

try {
  const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"`;
  const output = execSync(cmd, { encoding: "utf8" }).trim();
  
  if (!output) {
    console.log("No node processes found.");
    process.exit(0);
  }

  let processes = [];
  if (output.startsWith("[")) {
    processes = JSON.parse(output);
  } else if (output.startsWith("{")) {
    processes = [JSON.parse(output)];
  }

  for (const proc of processes) {
    console.log(`${proc.ProcessId} : ${proc.CommandLine}`);
  }
} catch (err) {
  console.error("Error:", err.message);
}
