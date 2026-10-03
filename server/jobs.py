"""Streamed jobs that outlive their connection.

A job keeps every event it emitted, so a client whose stream dropped can follow it again from where it
left off (GET /api/tasks/{tid}/events?after=N). Closing a stream does not cancel the work: a running job
nobody follows for KEEP_S seconds is cancelled, and a job is forgotten KEEP_S after its last follower or
its end, whichever is later.
"""
import asyncio
import time
import uuid

KEEP_S = 300
PING_S = 15     # an SSE comment this often keeps proxies and the browser from closing a quiet stream


class Job:
    def __init__(self):
        self.id = uuid.uuid4().hex[:12]
        self.events: list[dict] = []
        self.skip = asyncio.Event()             # "retry now" button
        self.task: asyncio.Task | None = None
        self.ended = False
        self.followers = 0
        self.last_seen = time.monotonic()       # last time a follower left or the job ended
        self._wake = asyncio.Event()

    def push(self, ev: dict) -> None:
        self.events.append(ev)
        self._wake.set()
        self._wake = asyncio.Event()

    def end(self) -> None:
        self.ended = True
        self.last_seen = time.monotonic()
        self._wake.set()

    async def follow(self, after: int = 0):
        """Yield the events from index `after` on, live; None every PING_S seconds of silence."""
        i = max(0, after)
        while True:
            while i < len(self.events):
                yield self.events[i]
                i += 1
            if self.ended:
                return
            wake = self._wake
            try:
                await asyncio.wait_for(wake.wait(), PING_S)
            except asyncio.TimeoutError:
                yield None


class Jobs:
    def __init__(self, keep_s: float = KEEP_S):
        self.keep_s = keep_s
        self.all: dict[str, Job] = {}

    def get(self, tid: str) -> Job | None:
        return self.all.get(tid)

    def add(self, job: Job) -> None:
        self.all[job.id] = job

    def attach(self, job: Job) -> None:
        job.followers += 1

    def detach(self, job: Job) -> None:
        job.followers -= 1
        if job.followers <= 0:
            job.followers = 0
            job.last_seen = time.monotonic()
            self._schedule(job)

    def ended(self, job: Job) -> None:
        job.end()
        self._schedule(job)

    def _schedule(self, job: Job) -> None:
        asyncio.get_running_loop().call_later(self.keep_s, self.reap, job.id)

    def reap(self, tid: str) -> None:
        job = self.all.get(tid)
        if not job or job.followers:
            return
        left = self.keep_s - (time.monotonic() - job.last_seen)
        if left > 0:    # a follower left again later, or the timer beat the coarse Windows clock
            asyncio.get_running_loop().call_later(left, self.reap, tid)
            return
        if job.task and not job.task.done():
            job.task.cancel()       # its runner pushes "cancelled" and ends the job, which reschedules
            return
        self.all.pop(tid, None)
