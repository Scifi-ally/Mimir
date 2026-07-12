import sys
import os

with open('backend/ai_service/main.py', 'r') as f:
    content = f.read()

content = content.replace('kronos_status', 'technical_engine_status')
content = content.replace('"kronos":', '"technical_engine":')
content = content.replace('kronos.', 'technical_pattern_engine.')
content = content.replace('kronos=', 'technical_ranking=')

with open('backend/ai_service/main.py', 'w') as f:
    f.write(content)
