# Reproducible environment for the lender-snapshot scripts, independent of the
# local Python install (avoids Homebrew / PEP 668 / Python-version issues).
#
# The source is mounted at runtime (see run.sh) so that the produced
# distribution_snapshot.json persists on the host and code changes are picked
# up without rebuilding the image. Only requirements.txt is needed at build time.
FROM python:3.12-slim

# Stream logs immediately (docker run without a TTY would otherwise block-buffer
# Python stdout, hiding progress output until the process exits).
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

CMD ["python", "snapshot_lenders.py"]
