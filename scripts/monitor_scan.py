#!/usr/bin/env python3
import requests
import json
import time
from datetime import datetime

url = "http://localhost:5000/api/system/offhours-scan"
watchlist_url = "http://localhost:5000/api/watchlist/tomorrow"

print("Monitoring overnight scanner...\n")
start_time = time.time()

while True:
    try:
        response = requests.get(url, timeout=5)
        status = response.json()
        
        elapsed = time.time() - start_time
        running = status.get('running', False)
        msg = status.get('lastScanMessage', 'In progress...')
        
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Elapsed: {elapsed:.0f}s | Running: {running} | Status: {status.get('lastScanStatus')} | {msg}")
        
        if not running:
            print("\n✓ Scan completed!")
            print(f"Message: {msg}")
            print(f"Finished at: {status.get('lastScanFinishedAt')}")
            
            # Check watchlist
            try:
                wl_response = requests.get(watchlist_url, timeout=5)
                watchlist = wl_response.json()
                total_candidates = len(watchlist.get('intradayCandidates', []))
                print(f"Watchlist candidates: {total_candidates}")
                if total_candidates > 0:
                    for idx, cand in enumerate(watchlist['intradayCandidates'][:5], 1):
                        print(f"  {idx}. {cand.get('symbol')} - Priority: {cand.get('priority')}")
            except Exception as e:
                print(f"Error checking watchlist: {e}")
            
            break
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Error: {e}")
    
    time.sleep(2)

print("Done!")
