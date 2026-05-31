"""aips — Python + Celery workers for the ai-ps AI image editor.

Bridges the Node API (which enqueues jobs onto a Redis list) to Celery tasks,
executes heavy image/AI work (OpenRouter text-to-image, etc.), stores artifacts
in MinIO, and publishes progress back over Redis pub/sub.
"""

__version__ = "0.1.0"
