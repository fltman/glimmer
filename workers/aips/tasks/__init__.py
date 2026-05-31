"""Celery tasks. Importing the package registers all task modules."""

from . import (  # noqa: F401
    color_match,
    echo,
    harmonize,
    image_edit,
    inpaint,
    outpaint,
    relight,
    remove_reflections,
    segment,
    text_to_image,
    upscale,
)
