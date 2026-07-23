import os
import re

symbols = [
  "OHLCV", "TechnicalSnapshot", "SetupCandidate", "BollingerBands", "MACDResult",
  "computeSMA", "computeEMA", "fastEMA", "computeRSI", "computeATR", "fastATR",
  "computeADX", "fastADX", "computeVolumeRatio", "computeRollingVWAP",
  "fastRollingVWAP", "computeSuperTrend", "fastSuperTrend", "calculateVPVR",
  "computeStandardDeviation", "computeBollingerBands", "computeMACD",
  "computeSwingPoints", "detectBreakout", "detectPullback", "detectMomentum",
  "detectEma9Reclaim", "detectBreakdown", "detectBearMomentum",
  "detectEma9Rejection", "detectMacdCrossover", "detectBollingerSqueezeBreakout",
  "detectLiquiditySweep"
]

def fix_file(p):
    c = open(p).read()
    c = re.sub(r'import\s+\{.*?\}\s+from\s+[\'\"].*?technical[\'\"];\n', '', c, flags=re.DOTALL)
    
    if 'snapshot_utils.ts' in p:
        c = c.replace('function computeSwingPoints', 'export function computeSwingPoints')
        
    u = []
    for s in symbols:
        # Avoid importing symbols we are defining in this file
        if re.search(r'\b(export )?(function|interface|const)\s+' + s + r'\b', c): 
            continue
            
        if re.search(r'\b' + s + r'\b', c):
            u.append(s)
            
    if u:
        prefix = '"./technical"' if 'snapshot_utils.ts' in p else '"../technical"'
        c = 'import { ' + ', '.join(u) + ' } from ' + prefix + ';\n' + c
        
    open(p, 'w').write(c)

paths_to_check = []
for d in ['src/analysis/indicators', 'src/analysis/setups']:
    for root, _, files in os.walk(d):
        for f in files:
            if f.endswith('.ts'):
                paths_to_check.append(os.path.join(root, f))
                
paths_to_check.append('src/analysis/snapshot_utils.ts')

for p in paths_to_check:
    if os.path.exists(p):
        fix_file(p)

print("Fixed imports carefully")
