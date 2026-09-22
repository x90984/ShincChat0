# ShincChat P2P Architecture

ShincChat now runs on a **peer-to-peer content model**: chat content travels
directly between the two participants' devices, encrypted, instead of being
relayed and stored on a central server. The design follows the same family of
ideas as BitTorrent (peer-distributed data), Matrix (federation + E2E
encryption) and IPFS (content-addressed distribution), adapted to what a
browser can actually do for a live 1-on-1 chat app.

## What goes peer-to-peer (device ↔ device, encrypted)

Once two people are matched, one WebRTC peer connection is opened between
their browsers (yes, even in plain text mode). Everything content-related
flows over it:

| Content | Transport | Encrypted by |
| --- | --- | --- |
| Text messages | WebRTC **DataChannel** | DTLS (built into WebRTC) |
| Voice messages | DataChannel, chunked transfer | DTLS |
| Verify clips (blurred video) | DataChannel, chunked transfer | DTLS |
| Read receipts ("seen" acks) | DataChannel | DTLS |
| "Delete for everyone" notices | DataChannel | DTLS |
| Live voice calls | WebRTC audio tracks | SRTP |
| Live video | WebRTC video tracks | SRTP |

Message **IDs are minted on the sender's device**, not by any server.
**Message content is never written to the database** — chat history lives in
each participant's own browser (IndexedDB), so it follows the device, exactly
like a decentralized mailbox.

## What the central server still does (and why)

A browser cannot discover a random stranger with zero coordination — even
BitTorrent needs a DHT/tracker bootstrap, and Matrix needs homeservers for
offline mailboxes. The server is now reduced to that **content-blind
coordination role**:

- **Matchmaking** (who's waiting, gender/country/nearby scoping, pairing).
- **WebRTC signaling relay** — forwards opaque SDP offers/answers and ICE
  candidates between the two devices so they can find each other. It cannot
  read anything from these.
- **Trust & safety metadata** — accounts, reports, bans, blocks, mutes,
  friends, follows, reviews.
- **Content-free conversation metadata** — the sender's device pings the
  server once per message with just the *type* ("text"/"voice"), so the
  All-Chats list can show unread badges, ordering and a generic preview
  ("Message" / "🎤 Voice message") without ever seeing the text.
- **Tombstones** — ID-only markers for "delete for everyone", so a deletion
  still applies when the partner next opens the conversation.

The server literally cannot read a conversation: it never receives one.

## Resilience: automatic fallback + TURN

- If the direct P2P path can't be established (strict symmetric NAT, some
  mobile carriers), the app **automatically falls back to relaying text over
  the socket connection** — same features, content still never stored. Users
  never see a broken UI.
- To make those fallbacks rare, set the `TURN_URL` / `TURN_USERNAME` /
  `TURN_CREDENTIAL` env vars (self-hosted [coturn] or a managed TURN). With
  TURN configured, essentially every pairing connects P2P.

## Disappearing messages in P2P mode

- **24h** — each device drops entries older than 24h from its own store on
  load; both sides enforce it locally.
- **Once seen** — the receiver's device never persists the message at all;
  the sender's device deletes its local copy the moment the partner's device
  sends the "seen" ack over the data channel.

## Mapping the wider decentralization vision

| Idea | Status | Notes |
| --- | --- | --- |
| Pure P2P content transport (BitTorrent-style) | ✅ Done | WebRTC DataChannel/media, DTLS/SRTP encrypted |
| DHT / trackerless peer discovery | ◐ Partial | Browser WebRTC still needs a signaling rendezvous; our server is that content-blind rendezvous (the "tracker"). A WebTorrent-tracker or DHT-backed signaling relay could replace it later without touching the app. |
| Server never stores content | ✅ Done | Content-free metadata only |
| Magnet-link style zero-backend sharing | N/A | Applies to file distribution, not live matching |
| IPFS hosting of the app/landing page | ▶ Ready | `public/` and `../landing` are 100% static — deployable today on Fleek/4EVERLAND/Pinata; point the API base URL at the signaling server. |
| Federated homeservers (Matrix model) | 🔜 Roadmap | The signaling/matchmaking role is small and stateless-ish; it's the natural seam to split into federated nodes later (or bridge to Matrix/XMPP turnstiles). |
| Waku/libp2p offline message store-and-forward | 🔜 Roadmap | Not applicable while chats are live-paired only; becomes relevant when offline DMs ship. |
| UnifiedPush notifications | 🔜 Roadmap | Push subscriptions table already exists; a UnifiedPush distributor can front it for Android clients. |
| Mesh-pull vs decentralized SFU streaming | N/A today | ShincChat is 1-on-1 — a direct WebRTC connection is already the optimal topology. If 1-to-many live streaming is added later, start with federated SFU nodes (PeerTube model) for <500 ms latency; mesh-pull only for very large passive audiences. |

## Privacy properties summary

- Text, voice messages, verify clips: **end-to-end between devices** (DTLS),
  never stored server-side.
- Live audio/video: **already P2P** before this change; unchanged.
- Server sees: account info, who matched whom and when, message *types* and
  counts, reports/bans — never message content.
- History on-device: clearing browser storage deletes your history; there is
  no server copy to leak.

[coturn]: https://github.com/coturn/coturn
