"""Pixel pipelines for the "virtual" capabilities (inpaint, outpaint).

These wrap a provider's `image_edit` (Gemini-style edit) with the pre/post
processing the model itself does not do: ROI cropping, color/exposure matching
against the untouched region, mask feathering, and seam blending. The model is
treated as a black box that may change dimensions/color — we always re-align and
re-match its output to the known-good pixels before compositing.
"""
