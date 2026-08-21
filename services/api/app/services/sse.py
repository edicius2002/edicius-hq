"""
How a server-sent event is spelled on the wire.

Two lines and a blank one. It lived in `app.routers.market` because that router
was the only thing that streamed, and it stayed a private helper there for as
long as that was true — decision 8.19. It is here now because the fares router
streams a collection pass as well, and the second copy of a format is where a
format starts to drift: the trailing blank line is the whole of what tells an
`EventSource` that an event has ended, and a copy that grew one `\\n` instead of
two would leave a browser waiting forever for a frame that had already arrived.

Nothing here knows what is being streamed. The event name and the payload are
the caller's business; this only frames them.
"""

import json

#: What a stream says when it has nothing to say.
#:
#: A comment line, which `EventSource` reads and discards — so it costs the
#: client nothing but keeps bytes moving past any proxy that would otherwise
#: decide an idle connection had died. Named rather than written out at each
#: call site, because the leading colon is what makes it a comment and a copy
#: that lost it would deliver an empty event instead.
KEEP_ALIVE = ": keep-alive\n\n"


def sse(event: str, data: object) -> str:
    """One named event carrying JSON, framed the way `EventSource` expects."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"
