FROM python:3.12-slim

# Create a non-root user
RUN groupadd -r mimir && useradd -r -g mimir mimir

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY backend/ai_service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt gunicorn httpx

COPY backend/ai_service ./

# Change ownership to non-root user
RUN chown -R mimir:mimir /app

USER mimir

EXPOSE 8001
CMD ["gunicorn", "main:app", "--workers", "4", "--worker-class", "uvicorn.workers.UvicornWorker", "--bind", "0.0.0.0:8001"]
