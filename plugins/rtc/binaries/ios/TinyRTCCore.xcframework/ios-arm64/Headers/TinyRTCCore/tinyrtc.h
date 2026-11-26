// tinyrtc.h — the C face of the core. DRAFT: a proposal, nothing behind it yet but the spike.
//
// The core is the half of a call that is the same on every platform: ICE (with its own STUN
// client), DTLS, SRTP, RTP / RTCP, retransmission, bandwidth estimation, the data channels, the SDP
// of one fixed profile, Opus and the audio jitter buffer. The platform half (apple/, android/) is
// what the OS owns: the camera, the hardware H.264 codec, the audio unit with its echo canceller,
// the picture. What crosses this header is therefore:
//
//   video  encoded H.264 access units, both ways (the platform encodes and decodes)
//   audio  PCM, 48 kHz mono int16, both ways (the core encodes, decodes, conceals and mixes)
//   data   channel messages
//   text   the SDP and the candidates, for the app's signaling
//
// THE PROFILE (fixed; an SDP never says anything else):
//   m=audio  mid 0  Opus 48000/2, in-band FEC, always sendrecv
//   m=video  mid 1  H.264 Constrained Baseline 3.1 (42e01f), packetization-mode 1, RTX, always sendrecv
//   m=application mid 2  the data channels (SCTP)
// All three are in every offer, bundled on one transport. A side that sends no video simply sends
// none: turning the camera on or off is never a renegotiation. The only second offer a connection
// ever makes is an ICE restart.
//
// THREADS: every function may be called from any thread. A connection runs on a thread of its own;
// the calls below hand it a message; the ones marked SYNC also wait for its reply, well under a
// millisecond (the others return at once, whatever they return). Callbacks run on a core thread: copy what you need and return — the pointers in an
// event are dead when the callback returns — and do not call a function that waits (the ones marked
// SYNC) from inside one. A video source's callbacks may also run inside tinyrtc_connection_send_video
// and tinyrtc_video_source_set_limits, on the caller's thread, and they run with the source locked:
// never call a function of that source from inside them.
//
// HANDLES are owned by the caller: one `_create`, one `_destroy`, in any order between a context
// and what was made in it. A function given a NULL handle returns TINYRTC_ERR_HANDLE (or does
// nothing); a destroyed handle must not be used.

#ifndef TINYRTC_H
#define TINYRTC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TINYRTC_ABI_VERSION 1

typedef struct tinyrtc_context tinyrtc_context;         // the process's audio + the local sources
typedef struct tinyrtc_video_source tinyrtc_video_source; // one encoded H.264 stream going out (the camera)
typedef struct tinyrtc_connection tinyrtc_connection;   // one peer

typedef enum {
  TINYRTC_OK = 0,
  TINYRTC_ERR_HANDLE = -1,   // NULL
  TINYRTC_ERR_ARGUMENT = -2, // a malformed argument
  TINYRTC_ERR_STATE = -3,    // not now: an answer with no offer pending, a channel not open yet
  TINYRTC_ERR_SDP = -4,      // the description does not parse, or is outside the profile
  TINYRTC_ERR_NOT_FOUND = -5, // an unknown channel id
  TINYRTC_ERR_CLOSED = -6     // the connection is closed or failed: nothing will work on it again
} tinyrtc_status;

// Text the core allocated (an SDP). Release with tinyrtc_text_free; `data` is NUL-terminated UTF-8.
typedef struct {
  char *data;
  size_t len;
} tinyrtc_text;
void tinyrtc_text_free(tinyrtc_text text);

uint32_t tinyrtc_abi_version(void);

// ---- the context ----------------------------------------------------------------------------------

typedef enum { TINYRTC_LOG_OFF = 0, TINYRTC_LOG_ERROR, TINYRTC_LOG_WARN, TINYRTC_LOG_INFO, TINYRTC_LOG_DEBUG } tinyrtc_log_level;

typedef struct {
  // Lines of the core's log, on a core thread; NULL = silent.
  void (*log)(void *user, tinyrtc_log_level level, const char *line);
  tinyrtc_log_level log_level;
  void *user;
} tinyrtc_context_config;

tinyrtc_context *tinyrtc_context_create(const tinyrtc_context_config *config);
void tinyrtc_context_destroy(tinyrtc_context *context);

// The OS reported a change of network (Wi-Fi <-> cellular, an interface came or went). Every
// connection looks at its sockets again and, where the path is gone, raises
// TINYRTC_EVENT_ICE_RESTART_NEEDED.
void tinyrtc_context_network_changed(tinyrtc_context *context);

// ---- audio: one microphone in, one mix out ---------------------------------------------------------
//
// The platform's audio unit is the clock on both sides. Capture: push what the unit recorded (after
// the OS's echo canceller); the core encodes it ONCE and sends it on every connection that has the
// microphone on. Playout: pull from the unit's render callback; the core hands back the mix of every
// connection, each through its own jitter buffer, with loss concealed. Neither does I/O nor waits
// for the network: both are meant for the audio unit's own threads.

#define TINYRTC_AUDIO_RATE 48000 // always; mono; int16

// `frames` = any count; the core cuts its own 20 ms packets.
void tinyrtc_audio_push(tinyrtc_context *context, const int16_t *pcm, size_t frames);
// Fills `pcm` with exactly `frames` samples: the mix, or silence where there is nothing.
void tinyrtc_audio_pull(tinyrtc_context *context, int16_t *pcm, size_t frames);

// ---- video out: one encoded stream, sent to every connection that takes it --------------------------
//
// The platform owns the encoder; the core tells it what the network can carry. In a group (a mesh)
// the stream is encoded once: the target is the smallest of the connections' estimates.

typedef enum {
  TINYRTC_H264_ANNEX_B = 0, // 00 00 00 01 start codes (MediaCodec)
  TINYRTC_H264_AVCC = 1     // 4-byte big-endian lengths (VideoToolbox); parameter sets as NAL units in the buffer on a keyframe
} tinyrtc_h264_framing;

typedef struct {
  // What the encoder should produce from now on. First called when the first connection takes the
  // source; then when it changes by more than a step, at most a few times a second.
  void (*target)(void *user, uint32_t bitrate_bps, uint32_t max_fps, uint32_t max_height);
  // A receiver lost the picture: the next frame must be a keyframe. Already rate-limited.
  void (*keyframe)(void *user);
  void *user;
} tinyrtc_video_source_callbacks;

tinyrtc_video_source *tinyrtc_video_source_create(tinyrtc_context *context, const tinyrtc_video_source_callbacks *callbacks);
// No callback of the source is running or will run once this returns; the connections that were
// sending it send no video from then on.
void tinyrtc_video_source_destroy(tinyrtc_video_source *source);

// The ceiling the app asked for (a setting, a constraint); the target never goes above it.
// 0 = no ceiling of that kind. Defaults: 1 500 000 bps, 30 fps, 720.
void tinyrtc_video_source_set_limits(tinyrtc_video_source *source, uint32_t max_bitrate_bps, uint32_t max_fps, uint32_t max_height);

typedef struct {
  const uint8_t *data;       // one access unit: every NAL unit of one picture
  size_t len;
  tinyrtc_h264_framing framing;
  int64_t capture_time_us;   // when the camera took it, on any steady clock: only differences are used
  uint8_t keyframe;          // 1 = an IDR, with its SPS and PPS in the buffer
  uint16_t rotation;         // 0 / 90 / 180 / 270, clockwise, to show it upright (sent as an RTP extension)
} tinyrtc_video_frame_in;

// Copies the frame and returns at once.
void tinyrtc_video_source_send(tinyrtc_video_source *source, const tinyrtc_video_frame_in *frame);

// ---- a connection ----------------------------------------------------------------------------------

typedef enum {
  TINYRTC_STATE_NEW = 0,
  TINYRTC_STATE_CONNECTING,
  TINYRTC_STATE_CONNECTED,
  TINYRTC_STATE_DISCONNECTED, // the path is lost; it may come back, or an ICE restart brings it back
  TINYRTC_STATE_FAILED,
  TINYRTC_STATE_CLOSED
} tinyrtc_state;

typedef enum { TINYRTC_MEDIA_AUDIO = 0, TINYRTC_MEDIA_VIDEO = 1 } tinyrtc_media;

typedef struct {
  const uint8_t *data;
  size_t len;
  uint8_t type; // the NAL unit type: 7 = SPS, 8 = PPS, 5 = IDR slice, 1 = slice
} tinyrtc_nal;

typedef enum {
  TINYRTC_EVENT_STATE = 1,              // .state
  TINYRTC_EVENT_LOCAL_CANDIDATE,        // .candidate: for the other side, through the app's signaling
  TINYRTC_EVENT_ICE_RESTART_NEEDED,     // the offering side should call tinyrtc_connection_offer(.., 1)
  TINYRTC_EVENT_REMOTE_MEDIA,           // .remote_media: the other side started / stopped sending a kind
  TINYRTC_EVENT_VIDEO_FRAME,            // .video: one picture to decode
  TINYRTC_EVENT_CHANNEL_OPEN,           // .channel (label set): opened by either side
  TINYRTC_EVENT_CHANNEL_MESSAGE,        // .message
  TINYRTC_EVENT_CHANNEL_BUFFERED_LOW,   // .channel
  TINYRTC_EVENT_CHANNEL_CLOSED          // .channel
} tinyrtc_event_type;

typedef struct {
  const char *candidate; // the `candidate:` line; mid and index are fixed by the profile
} tinyrtc_event_candidate;

typedef struct {
  tinyrtc_media media;
  uint8_t active;
} tinyrtc_event_remote_media;

typedef struct {
  // In order; the platform frames them as its decoder wants. Every frame handed out can be
  // decoded after the ones before it: when one was lost, the core withholds the rest until
  // the next keyframe and asks the other side for it.
  const tinyrtc_nal *nals;
  size_t nal_count;
  uint8_t keyframe;
  uint16_t rotation;
  int64_t play_delay_us; // show it this long from now to stay in step with the sound (0 = at once)
  uint32_t rtp_timestamp;
} tinyrtc_event_video;

typedef struct {
  uint32_t id;
  const char *label; // NULL in the events that name a channel only by its id
} tinyrtc_event_channel;

typedef struct {
  uint32_t id;
  const uint8_t *data;
  size_t len;
  uint8_t binary;
} tinyrtc_event_message;

typedef struct {
  tinyrtc_event_type type;
  union {
    tinyrtc_state state;
    tinyrtc_event_candidate candidate;
    tinyrtc_event_remote_media remote_media;
    tinyrtc_event_video video;
    tinyrtc_event_channel channel;
    tinyrtc_event_message message;
  };
} tinyrtc_event;

typedef struct {
  const char *url;        // "stun:host:port" (anything else is ignored: there is no TURN)
  const char *username;   // not used; NULL
  const char *credential;
} tinyrtc_ice_server;

typedef struct {
  const tinyrtc_ice_server *ice_servers;
  size_t ice_server_count;
  // 1 = never reveal an address of ours: the only path is a relay candidate the app adds (the
  // media server's blind relay of a 1:1 call), whatever else it adds. Ours are never shown: the
  // connection still sends from its own (host, reflexive) candidates, but no description it makes
  // carries an a=candidate line (an ICE restart's neither) and no TINYRTC_EVENT_LOCAL_CANDIDATE is
  // emitted. Theirs are never checked: of the other side's candidates — added, or inside a
  // description — only `typ relay` ones are taken (any other kind is ignored), and a datagram from
  // an address that is not such a relay is dropped. So the call needs a relay candidate to
  // connect, and the other side never hears from our address. What still sees it: the relay, and
  // the STUN servers of ice_servers (they are asked; their answer is never shown). An ICE restart
  // has new credentials: the media server's relay needs a new reservation for them.
  uint8_t relay_only;
  void (*event)(void *user, const tinyrtc_event *event);
  void *user;
} tinyrtc_connection_config;

tinyrtc_connection *tinyrtc_connection_create(tinyrtc_context *context, const tinyrtc_connection_config *config);
// Closes (the other side sees it at once) and frees. No callback runs after it returns. SYNC.
void tinyrtc_connection_destroy(tinyrtc_connection *connection);

// -- signaling: three calls. The candidates gathered later arrive as TINYRTC_EVENT_LOCAL_CANDIDATE.
// The offering side: make the offer (ice_restart = 1 for the second and later ones). SYNC.
tinyrtc_status tinyrtc_connection_offer(tinyrtc_connection *connection, uint8_t ice_restart, tinyrtc_text *offer);
// The answering side: take the offer, get the answer. SYNC.
tinyrtc_status tinyrtc_connection_accept_offer(tinyrtc_connection *connection, const char *offer, tinyrtc_text *answer);
// The offering side: take the answer. SYNC.
tinyrtc_status tinyrtc_connection_accept_answer(tinyrtc_connection *connection, const char *answer);
// A candidate of the other side, or a relay's (`typ relay`: the media server's line); NULL = it
// has no more. One that does not parse, or (relay_only) is not a relay's, is ignored.
tinyrtc_status tinyrtc_connection_add_candidate(tinyrtc_connection *connection, const char *candidate);

// -- what this connection sends. Both off at creation.
void tinyrtc_connection_send_audio(tinyrtc_connection *connection, uint8_t on);                 // the microphone
void tinyrtc_connection_send_video(tinyrtc_connection *connection, tinyrtc_video_source *source);  // NULL = none
// Leave this connection's sound out of the mix (it still arrives).
void tinyrtc_connection_mute_playout(tinyrtc_connection *connection, uint8_t muted);
// The decoder cannot go on (a failed decode): ask the other side for a keyframe. Rate-limited.
void tinyrtc_connection_request_keyframe(tinyrtc_connection *connection);

// -- data channels. Opened in-band: no renegotiation, usable once TINYRTC_EVENT_CHANNEL_OPEN came.
typedef struct {
  uint8_t unordered;          // default 0 = ordered
  int32_t max_retransmits;    // -1 = reliable
  int32_t max_packet_life_ms; // -1 = reliable; at most one of the two
} tinyrtc_channel_options;

// SYNC. `id` is the core's id of the channel, the one the events carry.
tinyrtc_status tinyrtc_channel_open(tinyrtc_connection *connection, const char *label, const tinyrtc_channel_options *options, uint32_t *id);
// SYNC.
tinyrtc_status tinyrtc_channel_send(tinyrtc_connection *connection, uint32_t id, const uint8_t *data, size_t len, uint8_t binary);
// Bytes queued and not yet sent. SYNC.
tinyrtc_status tinyrtc_channel_buffered(tinyrtc_connection *connection, uint32_t id, uint64_t *bytes);
tinyrtc_status tinyrtc_channel_set_buffered_low(tinyrtc_connection *connection, uint32_t id, uint64_t threshold);
tinyrtc_status tinyrtc_channel_close(tinyrtc_connection *connection, uint32_t id);

// -- numbers. One fixed struct, not a report: what a call screen and a bug report need.
typedef struct {
  tinyrtc_state state;
  uint8_t relayed;                 // not reported yet: always 0
  uint32_t rtt_ms;
  uint32_t send_estimate_bps;      // what the network is believed to carry
  uint32_t audio_send_bps, audio_recv_bps;
  uint32_t video_send_bps, video_recv_bps;
  float audio_loss, video_loss;    // received: the share lost, 0..1, over the last seconds
  uint32_t audio_jitter_buffer_ms; // the delay the sound is played with
  uint32_t video_recv_fps;
  uint32_t video_nacks_sent, video_keyframes_requested;
  uint64_t bytes_sent, bytes_received;
} tinyrtc_stats;

// SYNC.
tinyrtc_status tinyrtc_connection_stats(tinyrtc_connection *connection, tinyrtc_stats *stats);

#ifdef __cplusplus
}
#endif

#endif // TINYRTC_H
