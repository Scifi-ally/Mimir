import sys
import os

with open('backend/ai_service/main.py', 'r') as f:
    content = f.read()

content = content.replace('Kronos-small', 'Technical Pattern Engine')
content = content.replace('Kronos model', 'Technical Pattern Engine')
content = content.replace('Kronos inference', 'Technical Pattern Engine inference')
content = content.replace('KronosRequest', 'TechnicalRankingRequest')
content = content.replace('kronos=TechnicalRankingResponse', 'technical_ranking=TechnicalRankingResponse')
content = content.replace('/inference/kronos', '/inference/technical_ranking')
content = content.replace('infer_kronos', 'infer_technical_ranking')
content = content.replace('req: KronosRequest', 'req: TechnicalRankingRequest')
content = content.replace('technical_pattern_engine.KronosResult', 'technical_pattern_engine.TechnicalPatternResult')
content = content.replace('Kronos bullish', 'Technical bullish')
content = content.replace('kronos_component', 'technical_component')
content = content.replace('runs Kronos', 'runs Technical Pattern Engine')
content = content.replace('from models import technical_pattern_engine', 'from models import technical_pattern_engine')

with open('backend/ai_service/main.py', 'w') as f:
    f.write(content)
