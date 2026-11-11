//
//  BackgroundAudioService.swift — lecodes-plugins/background-audio
//
//  One record: an AVPlayer under the `playback` audio session (with the app's `audio` background
//  mode it plays on in the background and with the screen locked), shown by the system through the
//  Now Playing center — the title on the lock screen, its play / pause and its scrubber, a
//  headset's button (MPRemoteCommandCenter). The app's code does not run in the background: the
//  buttons are answered here. An interruption (a call) pauses the player; it goes on when the
//  system says the record should. The channel (the calls, the events, their types) is
//  BackgroundAudio.gen.swift, generated from contract.d.ts. Main thread.
//
//  The state is read off the player after every change of it, whoever made it — the app, the lock
//  screen, a headset, an interruption: one place says it (`sync`). The position is a `@lazy` event:
//  it ticks only while the app listens AND is in the foreground.
//

import AVFoundation
import Foundation
import MediaPlayer
import UIKit
import LeCodes

final class BackgroundAudioService: NSObject, BackgroundAudioPlugin {

    private let events: BackgroundAudioEvents
    private var player: AVPlayer?
    private var item: AVPlayerItem?
    /// The record the player was made for.
    private var track: Track?

    private var state: PlaybackState = .idle
    /// Seconds; 0 while the record's length is not known.
    private var duration: Double = 0
    /// Where the record starts, asked before the player could seek.
    private var startAt: Double = 0
    /// The record was heard to its end (the player only says "paused" then).
    private var ended = false
    private var foreground = true

    private var ticker: Timer?
    private var observations: [NSKeyValueObservation] = []
    /// The observers of the record that plays (its end, its failure).
    private var itemObservers: [NSObjectProtocol] = []
    /// The observers of the session's life (an interruption, the app's foreground).
    private var lifeObservers: [NSObjectProtocol] = []
    /// The lock screen's buttons, while a record is shown there.
    private var commands: [(command: MPRemoteCommand, target: Any)] = []

    init(_ events: BackgroundAudioEvents) {
        self.events = events
        super.init()
        let center = NotificationCenter.default
        lifeObservers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.foreground = false
                self?.pace()
            },
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.foreground = true
                self?.tick()
                self?.pace()
            },
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                self?.interrupted(note)
            },
        ]
    }

    // MARK: - the player

    /// A player for the record, from `from` seconds, playing.
    private func start(_ track: Track, from: Double) {
        release()
        guard let url = URL(string: track.src) else {
            self.track = track
            return set(.failed)
        }
        // `playback`: heard with the Ring/Silent switch off, and — with the background mode — in the
        // background. `spokenAudio`: another app's short sound pauses the record instead of talking over it.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)

        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.track = track
        self.item = item
        self.player = player
        startAt = max(0, from)
        duration = 0
        ended = false

        // KVO may answer on another thread: everything here is read on the main one.
        let onMain: (BackgroundAudioService) -> Void = { $0.sync() }
        observations = [
            item.observe(\.status) { [weak self] _, _ in DispatchQueue.main.async { if let self { self.ready(); onMain(self) } } },
            item.observe(\.duration) { [weak self] _, _ in DispatchQueue.main.async { if let self { onMain(self) } } },
            player.observe(\.timeControlStatus) { [weak self] _, _ in DispatchQueue.main.async { if let self { onMain(self) } } },
        ]
        let center = NotificationCenter.default
        itemObservers = [
            center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                self?.ended = true
                self?.sync()
                self?.hide()          // the record is over: the lock screen lets it go
            },
            center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                self?.sync()
            },
        ]
        show()
        set(.loading)
        player.play()
    }

    /// The item can play: its start, asked before it could seek.
    private func ready() {
        guard let item, let player, item.status == .readyToPlay, startAt > 0 else { return }
        let to = startAt
        startAt = 0
        player.seek(to: CMTime(seconds: to, preferredTimescale: 600))
    }

    /// The player is let go: nothing plays, nothing is downloaded, it says nothing more.
    private func release() {
        observations.forEach { $0.invalidate() }
        observations = []
        itemObservers.forEach { NotificationCenter.default.removeObserver($0) }
        itemObservers = []
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
        item = nil
        track = nil
        duration = 0
        startAt = 0
        ended = false
    }

    // MARK: - what the player does

    /// The state and the length as the player has them now.
    private func sync() {
        guard let player, let item else { return }
        let length = item.duration
        if length.isNumeric, length.seconds > 0, length.seconds != duration {
            duration = length.seconds
            events.duration(value: duration)
        }
        let next: PlaybackState
        if item.status == .failed || player.error != nil { next = .failed }
        else if ended { next = .ended }
        else {
            switch player.timeControlStatus {
            case .playing: next = .playing
            case .waitingToPlayAtSpecifiedRate: next = .loading
            // Paused by the app, a button, or the system: an interruption, headphones pulled out.
            default: next = .paused
            }
        }
        set(next)
    }

    private func set(_ next: PlaybackState) {
        guard next != state else { return }
        state = next
        events.state(value: next)
        tick()          // what moved the state moved the position: a listener hears where it stands
        pace()
        nowPlaying()
        if next == .failed { hide() }
    }

    private func position() -> Double {
        guard let player else { return startAt }
        let seconds = player.currentTime().seconds
        return seconds.isFinite && seconds >= 0 ? seconds : startAt
    }

    private func tick() {
        if foreground { events.position(value: position()) }      // sent only while the app listens: the glue's
    }

    /// The position ticks only while the record plays, the app listens and is in the foreground.
    private func pace() {
        ticker?.invalidate()
        ticker = nil
        guard events.positionObserved, foreground, state == .playing else { return }
        ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    }

    /// A call came in, another app took the sound: the player is paused by the system; when that is
    /// over and the system says the record should go on, it does.
    private func interrupted(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .ended,
              let player, !ended else { return }
        let options = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
        if options.contains(.shouldResume) { player.play() }
    }

    // MARK: - the lock screen

    /// The record on the lock screen and in the control center, with its buttons.
    private func show() {
        guard commands.isEmpty else { return nowPlaying() }
        let center = MPRemoteCommandCenter.shared()
        func on(_ command: MPRemoteCommand, _ handler: @escaping (BackgroundAudioService, MPRemoteCommandEvent) -> Void) {
            command.isEnabled = true
            let target = command.addTarget { [weak self] event in
                guard let self, self.player != nil else { return .noActionableNowPlayingItem }
                handler(self, event)
                return .success
            }
            commands.append((command, target))
        }
        on(center.playCommand) { me, _ in me.resumePlaying() }
        on(center.pauseCommand) { me, _ in me.player?.pause() }
        on(center.togglePlayPauseCommand) { me, _ in
            if me.state == .playing || me.state == .loading { me.player?.pause() } else { me.resumePlaying() }
        }
        on(center.changePlaybackPositionCommand) { me, event in
            if let event = event as? MPChangePlaybackPositionCommandEvent { me.move(to: event.positionTime) }
        }
        nowPlaying()
    }

    /// What the lock screen shows of the record: the title, the length, where it is and whether it
    /// runs — the system moves the scrubber itself between two of these.
    private func nowPlaying() {
        guard let track, !commands.isEmpty else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position(),
            MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? 1.0 : 0.0,
        ]
        if let artist = track.artist { info[MPMediaItemPropertyArtist] = artist }
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func hide() {
        for (command, target) in commands { command.removeTarget(target) }
        commands = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    // MARK: - the calls

    func play(_ track: Track, _ reply: Reply<Void, NoCode>) {
        start(track, from: track.position ?? 0)
        reply.resolve()
    }

    func pause(_ reply: Reply<Void, NoCode>) {
        player?.pause()
        reply.resolve()
    }

    func resume(_ reply: Reply<Void, NoCode>) {
        resumePlaying()
        reply.resolve()
    }

    /// Go on: after the end from the start, after a failure with the record asked for again.
    private func resumePlaying() {
        guard let track, state != .playing, state != .loading else { return }
        if state == .failed { return start(track, from: 0) }
        guard let player else { return }
        if ended {
            ended = false
            player.seek(to: .zero)
        }
        try? AVAudioSession.sharedInstance().setActive(true)
        show()
        player.play()
    }

    func seek(_ position: Double, _ reply: Reply<Void, NoCode>) {
        move(to: position)
        reply.resolve()
    }

    private func move(to position: Double) {
        let to = duration > 0 ? min(max(0, position), duration) : max(0, position)
        guard let player, let item, item.status == .readyToPlay else {
            startAt = to
            return tick()
        }
        player.seek(to: CMTime(seconds: to, preferredTimescale: 600)) { [weak self] _ in
            DispatchQueue.main.async {
                self?.tick()
                self?.nowPlaying()
            }
        }
    }

    func stop(_ reply: Reply<Void, NoCode>) {
        let had = player != nil
        release()
        hide()
        if had { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        set(.idle)
        reply.resolve()
    }

    func status(_ reply: Reply<Status, NoCode>) {
        reply.resolve(Status(state: state, duration: duration, position: position()))
    }

    func positionObserved(_ observed: Bool) {
        tick()
        pace()
    }

    func close() {
        ticker?.invalidate()
        ticker = nil
        release()
        hide()
        lifeObservers.forEach { NotificationCenter.default.removeObserver($0) }
        lifeObservers = []
    }
}
