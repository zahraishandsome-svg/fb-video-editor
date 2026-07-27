"""Facebook publishing - DELIBERATE PLACEHOLDER.

The pipeline stops at a finished MP4 on purpose; nothing is posted anywhere yet.
This module defines the shape the real implementation will take so the rest of
the portal can already call it.

To make it live later, fill in `_upload_reel` and flip `is_configured` to check
for a real token. The Graph API flow is a three-step resumable upload:

    1. POST /{page-id}/video_reels          start   -> video_id + upload_url
    2. POST {upload_url}                    transfer (binary body, offset headers)
    3. POST /{page-id}/video_reels          finish  (video_state=PUBLISHED)

Notes for whoever wires this up:
  * Reels cap at 90 seconds. Longer renders must go to /{page-id}/videos instead.
  * The page access token must be a non-expiring one; the existing registry at
    kindlytold/viral_machine/page_tokens.json already holds tokens in that form.
  * Never post the same rendered file to two pages - re-render with a fresh seed,
    otherwise the two uploads are byte-identical.
"""

REELS_MAX_SECONDS = 90


class NotConfigured(Exception):
    """Raised when a publish is attempted before Facebook is wired up."""


def is_configured(channel):
    """True once the channel has real Facebook credentials.

    Deliberately returns False: no token field is populated anywhere in the
    portal yet, and pretending otherwise would let jobs report success for
    posts that never happened.
    """
    return False


def target_endpoint(duration_seconds):
    """Which Graph edge a render of this length should go to."""
    return "video_reels" if duration_seconds <= REELS_MAX_SECONDS else "videos"


def publish(channel, job):
    """Post a finished render to the channel's Facebook page.

    Returns a dict with the created post id on success.
    """
    if not is_configured(channel):
        raise NotConfigured(
            "Facebook posting is not wired up yet - the render is finished and "
            "waiting. Add a page token to enable publishing."
        )
    return _upload_reel(channel, job)


def _upload_reel(channel, job):
    raise NotImplementedError("Graph API upload not implemented yet")
