"""Synthesizes every sound in Midnight Courier into Art/Audio/*.wav (48 kHz, 16-bit).

Run with any Python that has numpy (Blender's bundled interpreter works):
    /Applications/Blender.app/Contents/Resources/5.3/python/bin/python3.13 Scripts/make_audio.py
"""
import math
import os
import wave

import numpy as np

SR = 48000
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Art", "Audio")
rng = np.random.default_rng(42)


# -------------------------------------------------------------------------------------------------------
# Building blocks
# -------------------------------------------------------------------------------------------------------
def t_axis(dur):
    return np.arange(int(SR * dur)) / SR


def noise(dur):
    return rng.standard_normal(int(SR * dur))


def onepole_lp(x, cutoff):
    """One-pole low-pass; cutoff may be an array (per-sample)."""
    c = np.broadcast_to(np.asarray(cutoff, dtype=np.float64), x.shape)
    a = np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x)
    acc = 0.0
    # vectorise in blocks where the cutoff is constant
    if np.ndim(cutoff) == 0:
        b = 1 - a[0]
        from_lfilter = _lfilter([b], [1, -a[0]], x)
        return from_lfilter
    for i in range(len(x)):
        acc = acc * a[i] + (1 - a[i]) * x[i]
        y[i] = acc
    return y


def _lfilter(b, a, x):
    # Direct-form IIR for short filters (first/second order), using numpy recursion via cumulative trick
    # when possible; falls back to a python loop (fine for our lengths).
    b = np.asarray(b, dtype=np.float64)
    a = np.asarray(a, dtype=np.float64)
    if len(a) == 2 and len(b) == 1:
        # y[n] = b0 x[n] - a1 y[n-1]
        y = np.empty_like(x)
        acc = 0.0
        b0, a1 = b[0], a[1]
        for i in range(len(x)):
            acc = b0 * x[i] - a1 * acc
            y[i] = acc
        return y
    y = np.zeros_like(x)
    for n in range(len(x)):
        acc = 0.0
        for k in range(len(b)):
            if n - k >= 0:
                acc += b[k] * x[n - k]
        for k in range(1, len(a)):
            if n - k >= 0:
                acc -= a[k] * y[n - k]
        y[n] = acc
    return y


def fft_filter(x, lo=None, hi=None, slope=1.0):
    """Zero-phase band filter in the frequency domain (smooth edges)."""
    n = len(x)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    g = np.ones_like(f)
    if hi is not None:
        g *= 1.0 / (1.0 + (f / hi) ** (4 * slope))
    if lo is not None:
        g *= 1.0 / (1.0 + (lo / np.maximum(f, 1e-3)) ** (4 * slope))
    return np.fft.irfft(X * g, n)


def env_adsr(n, a, d, s, r, total):
    t = np.arange(n) / SR
    e = np.zeros(n)
    e = np.where(t < a, t / max(a, 1e-6), e)
    e = np.where((t >= a) & (t < a + d), 1 - (1 - s) * (t - a) / max(d, 1e-6), e)
    e = np.where((t >= a + d) & (t < total - r), s, e)
    e = np.where(t >= total - r, s * np.clip((total - t) / max(r, 1e-6), 0, 1), e)
    return e


def decay(n, tau):
    return np.exp(-np.arange(n) / SR / tau)


def reverb(x, seconds=2.0, mix=0.3, bright=6000.0, stereo=True):
    """Convolution with a synthetic, exponentially decaying noise tail."""
    n = int(SR * seconds)
    outs = []
    for ch in range(2 if stereo else 1):
        ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR / (seconds / 6.9))
        ir = fft_filter(ir, lo=200, hi=bright)
        ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
        L = len(x) + n
        N = 1 << (L - 1).bit_length()
        y = np.fft.irfft(np.fft.rfft(x, N) * np.fft.rfft(ir, N), N)[:L]
        outs.append(y)
    dry = np.concatenate([x, np.zeros(n)])
    if stereo:
        return np.stack([dry * (1 - mix) + outs[0] * mix, dry * (1 - mix) + outs[1] * mix], axis=1)
    return dry * (1 - mix) + outs[0] * mix


def loopify(x, xfade=0.25):
    """Make a seamless loop by crossfading the tail into the head."""
    n = int(SR * xfade)
    if x.ndim == 1:
        head, tail = x[:n], x[-n:]
        w = np.linspace(0, 1, n)
        body = x[n:-n].copy() if len(x) > 2 * n else x[n:].copy()
        mixed = tail * (1 - w) + head * w
        return np.concatenate([mixed, x[n:len(x) - n]])
    out = np.stack([loopify(x[:, c], xfade) for c in range(x.shape[1])], axis=1)
    return out


def normalize(x, peak=0.9):
    m = np.max(np.abs(x)) + 1e-9
    return x * (peak / m)


def save(name, x, peak=0.9):
    os.makedirs(OUT, exist_ok=True)
    x = normalize(x, peak)
    data = np.clip(x * 32767, -32768, 32767).astype(np.int16)
    ch = 1 if data.ndim == 1 else data.shape[1]
    with wave.open(os.path.join(OUT, name + ".wav"), "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    print("MC_AUDIO", name, f"{len(x) / SR:.2f}s")


def fit(x, n):
    """Crop or zero-pad to exactly n samples."""
    return x[:n] if len(x) >= n else np.pad(x, (0, n - len(x)))


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def saw(f, t, detune=0.0):
    ph = np.cumsum(np.broadcast_to(f * (1 + detune), t.shape)) / SR
    return 2 * (ph % 1.0) - 1


def tri(f, t):
    ph = (f * t) % 1.0
    return 4 * np.abs(ph - 0.5) - 1


def place(buf, x, at):
    i = int(at * SR)
    if i >= len(buf):
        return
    m = min(len(x), len(buf) - i)
    buf[i:i + m] += x[:m]


# -------------------------------------------------------------------------------------------------------
# Ambience + bike loops
# -------------------------------------------------------------------------------------------------------
def rain_loop():
    dur = 10.0
    n = int(SR * dur)
    out = np.zeros((n, 2))
    for c in range(2):
        bed = fft_filter(noise(dur), lo=300, hi=9000) * 0.35
        bed += fft_filter(noise(dur), lo=60, hi=500) * 0.25          # low roar
        # droplets: short filtered clicks on gutters and puddles
        drops = np.zeros(n)
        for _ in range(2600):
            at = rng.uniform(0, dur - 0.05)
            f = rng.uniform(1500, 6000)
            m = int(0.012 * SR)
            tt = np.arange(m) / SR
            click = np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.002) * rng.uniform(0.05, 0.4)
            place(drops, click, at)
        # a few fat drips
        for _ in range(40):
            at = rng.uniform(0, dur - 0.2)
            m = int(0.08 * SR)
            tt = np.arange(m) / SR
            f = rng.uniform(500, 1200) * (1 + 3 * np.exp(-tt / 0.01))
            ph = np.cumsum(f) / SR
            place(drops, np.sin(2 * np.pi * ph) * np.exp(-tt / 0.02) * rng.uniform(0.2, 0.6), at)
        out[:, c] = bed + drops * 0.5
    save("A_RainLoop", loopify(out, 0.5), 0.7)


def city_loop():
    dur = 12.0
    t = t_axis(dur)
    out = np.zeros((len(t), 2))
    for c in range(2):
        hum = fft_filter(noise(dur), lo=30, hi=160) * 0.6
        hum += np.sin(2 * np.pi * 50 * t) * 0.03 + np.sin(2 * np.pi * 100 * t) * 0.015
        # distant traffic swells
        sw = np.zeros(len(t))
        for _ in range(5):
            at = rng.uniform(0, dur)
            w = np.exp(-((t - at) / rng.uniform(1.0, 2.5)) ** 2)
            sw += w
        traffic = fft_filter(noise(dur), lo=80, hi=900) * sw * 0.5
        out[:, c] = hum + traffic
    save("A_CityLoop", loopify(out, 1.0), 0.6)


def wind_loop():
    dur = 6.0
    t = t_axis(dur)
    x = fft_filter(noise(dur), lo=150, hi=1800)
    mod = 0.7 + 0.3 * np.sin(2 * np.pi * 0.37 * t) + 0.15 * np.sin(2 * np.pi * 1.3 * t + 1)
    x2 = fft_filter(noise(dur), lo=900, hi=4000) * 0.3
    save("A_WindLoop", loopify((x + x2) * mod, 0.5), 0.8)


def roll_loop():
    dur = 3.0
    t = t_axis(dur)
    hiss = fft_filter(noise(dur), lo=1200, hi=8000) * 0.6          # wet tyre hiss
    rumble = fft_filter(noise(dur), lo=40, hi=250) * 0.5
    tread = np.sin(2 * np.pi * 85 * t) * 0.05
    save("A_RollLoop", loopify(hiss + rumble + tread, 0.3), 0.8)


def freewheel_loop():
    dur = 1.0
    n = int(SR * dur)
    x = np.zeros(n)
    ticks = 20
    for k in range(ticks):
        m = int(0.006 * SR)
        tt = np.arange(m) / SR
        click = (np.sin(2 * np.pi * 5200 * tt) + 0.5 * np.sin(2 * np.pi * 8300 * tt)) * np.exp(-tt / 0.0012)
        place(x, click * rng.uniform(0.7, 1.0), k / ticks)
    save("A_FreewheelLoop", x, 0.7)


def chain_loop():
    dur = 1.0
    t = t_axis(dur)
    whir = fft_filter(noise(dur), lo=2000, hi=7000) * 0.25 * (0.7 + 0.3 * np.sin(2 * np.pi * 8 * t))
    clunk = np.zeros(len(t))
    for k in range(2):
        m = int(0.05 * SR)
        tt = np.arange(m) / SR
        place(clunk, np.sin(2 * np.pi * 140 * tt) * np.exp(-tt / 0.012) * 0.5, k * 0.5)
    save("A_ChainLoop", whir + clunk, 0.6)


def skid_loop():
    dur = 2.0
    t = t_axis(dur)
    scrub = fft_filter(noise(dur), lo=400, hi=5000)
    squeal = np.sin(2 * np.pi * (1650 + 40 * np.sin(2 * np.pi * 5 * t)) * t) * 0.18
    save("A_SkidLoop", loopify(scrub * 0.8 + squeal, 0.3), 0.75)


# -------------------------------------------------------------------------------------------------------
# One-shots
# -------------------------------------------------------------------------------------------------------
def thud(heavy):
    dur = 0.6 if heavy else 0.35
    t = t_axis(dur)
    f = (55 if heavy else 85) * (1 + 1.6 * np.exp(-t / 0.02))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.12 if heavy else 0.07))
    crunch = fft_filter(noise(dur), lo=200, hi=3000) * np.exp(-t / 0.03) * 0.6
    rattle = fft_filter(noise(dur), lo=2500, hi=9000) * np.exp(-t / 0.08) * (0.3 if heavy else 0.15)
    return body + crunch + rattle


def clack():
    dur = 0.25
    t = t_axis(dur)
    x = np.sin(2 * np.pi * 180 * t) * np.exp(-t / 0.02) + fft_filter(noise(dur), lo=800, hi=6000) * np.exp(-t / 0.015) * 0.7
    # metal ring from the bike frame
    x += (np.sin(2 * np.pi * 1870 * t) + 0.6 * np.sin(2 * np.pi * 2730 * t)) * np.exp(-t / 0.06) * 0.15
    return x


def wall_hit():
    dur = 0.5
    t = t_axis(dur)
    x = fit(thud(False), len(t))
    scrape = fft_filter(noise(dur), lo=600, hi=6000) * np.exp(-t / 0.12) * 0.5
    return x + scrape


def glass_tink(seed):
    r = np.random.default_rng(seed)
    dur = 0.5
    t = t_axis(dur)
    x = np.zeros(len(t))
    for _ in range(3):
        f = r.uniform(2800, 6200)
        at = r.uniform(0, 0.06)
        tt = np.clip(t - at, 0, None)
        partial = (np.sin(2 * np.pi * f * tt) + 0.5 * np.sin(2 * np.pi * f * 2.71 * tt) + 0.3 * np.sin(2 * np.pi * f * 4.1 * tt))
        x += partial * np.exp(-tt / r.uniform(0.05, 0.15)) * (t >= at) * r.uniform(0.4, 1.0)
    return x


def glass_crack():
    dur = 0.9
    t = t_axis(dur)
    snap = fft_filter(noise(dur), lo=2000, hi=12000) * np.exp(-t / 0.01) * 1.2
    crk = np.zeros(len(t))
    for k in range(14):
        at = 0.005 + k * rng.uniform(0.006, 0.02)
        m = int(0.004 * SR)
        place(crk, rng.standard_normal(m) * np.exp(-np.arange(m) / SR / 0.001) * rng.uniform(0.3, 0.9), at)
    tinkles = sum(fit(np.pad(glass_tink(100 + k), (int(rng.uniform(0.02, 0.4) * SR), 0)), len(t)) * 0.5 for k in range(5))
    return snap + fft_filter(crk, lo=1500) + tinkles


def shatter():
    dur = 2.2
    t = t_axis(dur)
    burst = fft_filter(noise(dur), lo=1500, hi=14000) * np.exp(-t / 0.05)
    x = burst
    for k in range(30):
        at = rng.uniform(0.0, 1.0) ** 2 * 1.4
        x += fit(np.pad(glass_tink(200 + k), (int(at * SR), 0)), len(t)) * rng.uniform(0.2, 0.6)
    low = np.sin(2 * np.pi * midi(40) * t) * np.exp(-t / 0.8) * 0.3
    return x + low


def crash():
    dur = 1.6
    t = t_axis(dur)
    x = np.zeros(len(t))
    x[: len(thud(True))] += thud(True)
    for k in range(8):
        at = rng.uniform(0.05, 0.9)
        f = rng.uniform(900, 3200)
        tt = np.clip(t - at, 0, None)
        x += (np.sin(2 * np.pi * f * tt) + 0.6 * np.sin(2 * np.pi * f * 1.48 * tt)) * np.exp(-tt / 0.15) * (t >= at) * 0.25
        x += fft_filter(noise(dur), lo=500, hi=5000) * np.exp(-tt / 0.03) * (t >= at) * 0.3
    return x + fit(np.pad(glass_crack(), (int(0.1 * SR), 0)), len(t)) * 0.6


def splash():
    dur = 1.5
    t = t_axis(dur)
    body = fft_filter(noise(dur), lo=150, hi=4000) * np.exp(-t / 0.25)
    plop = np.sin(2 * np.pi * np.cumsum(120 * (1 + 2 * np.exp(-t / 0.03))) / SR) * np.exp(-t / 0.1)
    bubbles = np.zeros(len(t))
    for _ in range(30):
        at = rng.uniform(0.1, 1.2)
        m = int(0.03 * SR)
        tt = np.arange(m) / SR
        f = rng.uniform(400, 1400) * (1 + tt * 30)
        place(bubbles, np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.01) * 0.2, at)
    return body + plop + bubbles


def chime(notes, dur=1.2, tau=0.5, bright=1.0):
    t = t_axis(dur)
    x = np.zeros(len(t))
    for k, (n, at) in enumerate(notes):
        tt = np.clip(t - at, 0, None)
        f = midi(n)
        tone = np.sin(2 * np.pi * f * tt) + 0.4 * bright * np.sin(2 * np.pi * f * 2 * tt) + 0.15 * bright * np.sin(2 * np.pi * f * 3.01 * tt)
        x += tone * np.exp(-tt / tau) * (t >= at) * np.clip(tt / 0.004, 0, 1)
    return x


def beep(n, dur=0.16):
    t = t_axis(dur)
    return (np.sin(2 * np.pi * midi(n) * t) + 0.25 * np.sign(np.sin(2 * np.pi * midi(n) * t))) * env_adsr(len(t), 0.003, 0.03, 0.6, 0.06, dur)


def whoosh(dur=0.45, rising=True):
    t = t_axis(dur)
    x = noise(dur)
    cutoff = (300 + 4000 * (t / dur if rising else 1 - t / dur))
    y = np.zeros(len(t))
    # chunked moving band
    for k in range(0, len(t), 2400):
        seg = x[k:k + 2400]
        y[k:k + len(seg)] = fft_filter(seg, lo=cutoff[k] * 0.5, hi=cutoff[k] * 1.5)
    return y * np.sin(np.pi * t / dur) ** 2


def thunder(seed, dur=6.0):
    r = np.random.default_rng(seed)
    t = t_axis(dur)
    x = fft_filter(r.standard_normal(len(t)), lo=20, hi=220) * 1.5
    env = np.zeros(len(t))
    for _ in range(6):
        at = r.uniform(0, 1.8)
        env += np.exp(-np.clip(t - at, 0, None) / r.uniform(0.6, 1.8)) * (t >= at) * r.uniform(0.3, 1.0)
    crackle = fft_filter(r.standard_normal(len(t)), lo=300, hi=2000) * np.exp(-t / 0.4) * 0.3
    return x * env + crackle


def doorbell_jingle():
    # ding-dong + a little rising flourish
    x = chime([(76, 0.0), (72, 0.35)], dur=1.6, tau=0.6)
    x2 = chime([(72, 0.9), (76, 1.0), (79, 1.1), (84, 1.2)], dur=2.4, tau=0.35, bright=0.6)
    out = np.zeros(int(SR * 2.4))
    out[: len(x)] += x * 0.8
    out[: len(x2)] += x2 * 0.6
    return reverb(out, 1.6, 0.3)


# -------------------------------------------------------------------------------------------------------
# Music
# -------------------------------------------------------------------------------------------------------
def pad_voice(freqs, dur, cutoff=1400.0):
    t = t_axis(dur)
    x = np.zeros(len(t))
    for f in freqs:
        for d in (-0.006, 0.0, 0.007):
            x += saw(f, t, d) * 0.2
    x = fft_filter(x, lo=80, hi=cutoff)
    return x * env_adsr(len(t), 0.6, 0.4, 0.8, 0.8, dur)


def kick(dur=0.45):
    t = t_axis(dur)
    f = 48 * (1 + 2.8 * np.exp(-t / 0.03))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)


def snare(dur=0.35):
    t = t_axis(dur)
    return fft_filter(noise(dur), lo=900, hi=7000) * np.exp(-t / 0.07) * 0.7 + np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05) * 0.4


def hat(dur=0.08, open_=False):
    t = t_axis(dur)
    return fft_filter(noise(dur), lo=7000, hi=15000) * np.exp(-t / (0.05 if open_ else 0.012))


def pluck(f, dur=0.5, bright=3000):
    t = t_axis(dur)
    x = tri(f, t) * 0.6 + saw(f, t) * 0.3
    x = fft_filter(x, hi=bright)
    return x * np.exp(-t / 0.18) * np.clip(t / 0.003, 0, 1)


def music_ride():
    bpm = 92.0
    beat = 60.0 / bpm
    bars = 8
    dur = bars * 4 * beat
    n = int(SR * dur)
    L = np.zeros(n)
    R = np.zeros(n)
    # A minor-ish progression: Am9, Fmaj7, Cadd9, G6
    chords = [[57, 60, 64, 67, 71], [53, 57, 60, 64], [48, 55, 60, 62, 64], [55, 59, 62, 64]]
    roots = [45, 41, 48, 43]
    for b in range(bars):
        ci = (b // 2) % 4
        at = b * 4 * beat
        if b % 2 == 0:
            p = pad_voice([midi(m) for m in chords[ci]], 2 * 4 * beat + 0.6, 1300 + 400 * (ci % 2))
            place(L, p * 0.55, at)
            place(R, p * 0.55, at + 0.011)
        # bass: pulsing eighths, ducked on the kick
        for e in range(8):
            tb = at + e * beat / 2
            dl = beat / 2 * 0.9
            tt = t_axis(dl)
            f = midi(roots[ci] - 12)
            bs = (np.sin(2 * np.pi * f * tt) + 0.3 * fft_filter(saw(f, tt), hi=400)) * env_adsr(len(tt), 0.005, 0.05, 0.7, 0.05, dl)
            gain = 0.45 if e % 2 == 0 else 0.7
            place(L, bs * gain * 0.6, tb)
            place(R, bs * gain * 0.6, tb)
        # drums
        for q in range(4):
            tq = at + q * beat
            if q in (0, 2):
                place(L, kick() * 0.8, tq)
                place(R, kick() * 0.8, tq)
            if q in (1, 3):
                s = reverb(snare(), 1.2, 0.35, stereo=True)
                place(L, s[:, 0] * 0.5, tq)
                place(R, s[:, 1] * 0.5, tq)
            for s16 in range(4):
                th = tq + s16 * beat / 4
                v = 0.22 if s16 % 2 == 0 else 0.12
                hh = hat(open_=(s16 == 2 and q == 3)) * v
                place(L, hh * (0.8 if s16 % 2 else 1.0), th)
                place(R, hh * (1.0 if s16 % 2 else 0.8), th)
        # arp in the second half of the loop, with a dotted-eighth echo
        if b >= 2:
            arp = chords[ci]
            for s16 in range(16):
                if (s16 * 7 + b) % 5 == 3:
                    continue
                note = arp[(s16 * 3) % len(arp)] + 12
                tn = at + s16 * beat / 4
                pk = pluck(midi(note), 0.45, 2400) * 0.16
                place(L, pk, tn)
                place(R, pk * 0.7, tn + beat * 0.75)
                place(L, pk * 0.35, tn + beat * 1.5)
    mix = np.stack([L, R], axis=1)
    wet = reverb(mix[:, 0] * 0.5 + mix[:, 1] * 0.5, 2.5, 1.0)
    out = mix + wet[:n] * 0.18
    # fold the reverb tail into the loop start
    tail = wet[n:] * 0.18
    out[: len(tail)] += tail[: n]
    save("A_MusicRide", out, 0.8)


def music_title():
    bpm = 70.0
    beat = 60.0 / bpm
    bars = 8
    dur = bars * 4 * beat
    n = int(SR * dur)
    L = np.zeros(n)
    R = np.zeros(n)
    chords = [[57, 64, 67, 72], [53, 60, 64, 69], [50, 57, 60, 65], [52, 59, 64, 67]]
    for b in range(bars):
        ci = (b // 2) % 4
        at = b * 4 * beat
        if b % 2 == 0:
            p = pad_voice([midi(m) for m in chords[ci]], 2 * 4 * beat + 1.0, 900)
            place(L, p * 0.6, at)
            place(R, p * 0.6, at + 0.013)
            sub = np.sin(2 * np.pi * midi(chords[ci][0] - 12) * t_axis(2 * 4 * beat)) * env_adsr(int(SR * 2 * 4 * beat), 0.5, 0.5, 0.8, 1.0, 2 * 4 * beat)
            place(L, sub * 0.35, at)
            place(R, sub * 0.35, at)
        # sparse "electric piano" notes
        for k in range(3):
            if (b + k) % 2 == 0:
                note = chords[ci][(k * 2 + b) % len(chords[ci])] + 12
                tn = at + (k * 1.25 + 0.5) * beat
                pk = chime([(note, 0.0)], dur=2.0, tau=0.9, bright=0.4) * 0.22
                place(L, pk, tn)
                place(R, pk * 0.8, tn + 0.02)
    mix = np.stack([L, R], axis=1)
    wet = reverb(mix[:, 0] * 0.5 + mix[:, 1] * 0.5, 3.5, 1.0)
    out = mix + wet[:n] * 0.3
    tail = wet[n:] * 0.3
    out[: len(tail)] += tail[: n]
    save("A_MusicTitle", out, 0.75)


def main():
    rain_loop()
    city_loop()
    wind_loop()
    roll_loop()
    freewheel_loop()
    chain_loop()
    skid_loop()
    save("A_ThudLight", thud(False))
    save("A_ThudHeavy", thud(True))
    save("A_Clack", clack())
    save("A_WallHit", wall_hit())
    save("A_Crash", crash())
    save("A_Splash", splash())
    save("A_GlassTink", glass_tink(7))
    save("A_GlassCrack", glass_crack())
    save("A_Failed", shatter())
    save("A_Perfect", reverb(chime([(79, 0.0), (86, 0.08)], 0.9, 0.35), 1.2, 0.25))
    save("A_Hop", whoosh(0.3, True) * 0.6)
    save("A_Beep", beep(72))
    save("A_Go", beep(84, 0.4))
    save("A_Restart", whoosh(0.5, False))
    save("A_UiMove", beep(88, 0.05))
    save("A_UiSelect", chime([(84, 0.0), (91, 0.05)], 0.4, 0.12))
    save("A_UiPause", chime([(72, 0.0)], 0.3, 0.1))
    save("A_UiCheckpoint", reverb(chime([(83, 0.0), (88, 0.09)], 0.8, 0.25), 1.0, 0.25))
    save("A_Delivered", doorbell_jingle())
    save("A_Thunder1", thunder(1))
    save("A_Thunder2", thunder(2, 7.5))
    music_ride()
    music_title()


if __name__ == "__main__":
    main()
