---
title: How to Watch YouTube Together in Perfect Sync
description: Paste a YouTube link, click load, and everyone in the room watches in sync — no extension required. Here's how it works.
keyword: watch youtube together
date: 2026-08-11
published: true
---

Most watch-party tools mention YouTube support somewhere in their feature list, but the actual flow is often buried behind an account, an extension, or a "supported sites" page you have to check first. Here's the direct version.

## The whole process

1. Go to [2gether Watch](/) and click **Create New Room** (or join a room someone already sent you).
2. Paste a `youtube.com/watch?v=…`, `youtu.be/…`, or `youtube.com/embed/…` link into the bar at the top of the room.
3. Click **Load**.

That's it — everyone currently in the room sees the same video load and stays in sync as it plays, pauses, or seeks.

## What "in sync" actually means

Play, pause, and seek events are relayed to every peer in the room over the same WebSocket signaling connection used to set up the WebRTC calls — so when one person pauses, everyone's player pauses. There's no polling or manual "sync now" button to click.

## Talking while you watch

Since calls are built into the same room, you don't need a separate Discord call or FaceTime running alongside the video — toggle your microphone and camera from the room's footer controls and talk normally while the video plays. If you'd rather share your screen instead of a link (a private YouTube video, a livestream you don't want to re-link, or literally anything else on your screen), the screen-share toggle is right next to the camera one.

## Direct video links work the same way

The same **Load** flow accepts any publicly accessible `http://` or `https://` video file (MP4, WebM, etc.) — not just YouTube. If your group has a direct link instead of a YouTube URL, paste that instead and it syncs the same way.

## No extension, no account

There's nothing to install and nothing to sign up for — [create a room](/), paste the link, and go.
