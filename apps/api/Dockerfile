FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir \
    pip==24.3.1 \
    setuptools==69.5.1 \
    wheel==0.45.1
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
    torch==2.0.1+cpu torchaudio==2.0.2+cpu
RUN pip install --no-cache-dir --no-build-isolation openai-whisper==20240930
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
