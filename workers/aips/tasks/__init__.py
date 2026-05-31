"""Celery tasks. Importing the package registers all task modules."""

from . import (  # noqa: F401
    echo,
    image_edit,
    inpaint,
    outpaint,
    segment,
    text_to_image,
    upscale,
)
