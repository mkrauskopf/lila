import pubsub from './pubsub';
import { assetUrl } from './assets';
import { storage } from './storage';
import { isIOS } from 'common/mobile';
import { charRole } from 'chess';

type Name = string;
type Path = string;

class Sound {
  node: GainNode;
  constructor(ctx: AudioContext, readonly buffer: AudioBuffer, readonly isThemed: boolean) {
    this.node = ctx.createGain();
    this.node.connect(ctx.destination);
  }
  maybeClose(): boolean {
    if (this.isThemed) this.node.disconnect();
    return this.isThemed;
  }
}

export type SoundMove = (node?: { san?: string; uci?: string }) => void;

export default new (class implements SoundI {
  ctx = new AudioContext();
  sounds = new Map<Name, Sound>(); // The loaded sounds and their instances
  theme = $('body').data('sound-set');
  speechStorage = storage.boolean('speech.enabled');
  volumeStorage = storage.make('sound-volume');
  baseUrl = assetUrl('sound', { version: '_____1' });
  soundMove?: SoundMove;

  async context() {
    if (this.ctx.state !== 'running' && this.ctx.state !== 'suspended') {
      // in addition to 'closed', iOS has 'interrupted'. who knows what else is out there
      this.ctx = new AudioContext();
      for (const s of this.sounds.values()) s.node.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    return this.ctx;
  }

  async load(name: Name, path?: Path, isThemed = false): Promise<Sound> {
    if (!path) {
      path = this.themePath(name);
      isThemed = true;
    }
    const result = await fetch(`${path}.mp3`);
    if (!result.ok) throw new Error(`${path}.mp3 failed ${result.status}`);

    const arrayBuffer = await result.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    const sound = new Sound(this.ctx, audioBuffer, isThemed);
    this.sounds.set(name, sound);
    return sound;
  }

  async cache(name: Name, theme?: string): Promise<Sound> {
    return this.sounds.get(name) ?? this.load(name, this.themePath(name, theme), true);
  }

  async play(name: Name, volume = 1): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.enabled()) resolve();
      let theme = this.theme;
      if (theme === 'music' || this.speechStorage.get()) {
        if (['move', 'capture', 'check'].includes(name)) return resolve();
        else theme = 'standard';
      }
      this.cache(name, theme)
        .then(async s => {
          const resumeTimer = setTimeout(() => {
            $('#warn-no-autoplay').addClass('shown');
            reject();
          }, 400);
          await this.context();
          clearTimeout(resumeTimer);
          s.node.gain.setValueAtTime(this.getVolume() * volume, this.ctx.currentTime);
          const source = this.ctx.createBufferSource();
          source.buffer = s.buffer;
          source.connect(s.node);
          source.onended = () => {
            source.disconnect();
            resolve();
          };
          source.start(0);
        })
        .catch(reject);
    });
  }

  async move(node?: { san?: string; uci?: string }) {
    if (this.theme !== 'music') return;
    this.soundMove ??= await lichess.loadEsm<SoundMove>('soundMove');
    this.soundMove(node);
  }

  async countdown(count: number, interval = 500): Promise<void> {
    if (!this.enabled()) return;
    try {
      while (count > 0) {
        const promises = [new Promise(r => setTimeout(r, interval)), this.play(`countDown${count}`)];

        if (--count > 0) promises.push(this.cache(`countDown${count}`));
        await Promise.all(promises);
      }
      await this.play('genericNotify');
    } catch (e) {
      console.error(e);
    }
  }

  playOnce(name: string): void {
    // increase chances that the first tab can put a local storage lock
    const doIt = () => {
      const storage = lichess.storage.make('just-played');
      if (Date.now() - parseInt(storage.get()!, 10) < 2000) return;
      storage.set('' + Date.now());
      this.play(name);
    };
    if (document.hasFocus()) doIt();
    else setTimeout(doIt, 10 + Math.random() * 500);
  }

  setVolume = this.volumeStorage.set;

  getVolume = () => {
    // garbage has been stored here by accident (e972d5612d)
    const v = parseFloat(this.volumeStorage.get() || '');
    return v >= 0 ? v : 0.7;
  };

  enabled = () => this.theme !== 'silent';

  speech = (v?: boolean): boolean => {
    if (v !== undefined) this.speechStorage.set(v);
    return this.speechStorage.get();
  };

  say = (text: string, cut = false, force = false, translated = false) => {
    try {
      if (cut) speechSynthesis.cancel();
      if (!this.speechStorage.get() && !force) return false;
      const msg = new SpeechSynthesisUtterance(text);
      msg.volume = this.getVolume();
      msg.lang = translated ? document.documentElement!.lang : 'en-US';
      if (!isIOS()) {
        // speech events are unreliable on iOS, but iphones do their own cancellation
        msg.onstart = _ => lichess.mic.pause();
        msg.onend = msg.onerror = _ => lichess.mic.resume();
      }
      speechSynthesis.speak(msg);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  };

  sayOrPlay = (name: string, text: string) => this.say(text) || this.play(name);

  publish = () => pubsub.emit('sound_set', this.theme);

  changeSet = (s: string) => {
    if (this.theme !== s)
      this.sounds = new Map([...this.sounds.entries()].filter(([, s]) => !s.maybeClose()));
    this.theme = s;
    this.publish();
    this.move();
  };

  set = () => this.theme;

  saySan(san?: San, cut?: boolean) {
    const text = !san
      ? 'Game start'
      : san.includes('O-O-O#')
      ? 'long castle checkmate'
      : san.includes('O-O-O+')
      ? 'long castle check'
      : san.includes('O-O-O')
      ? 'long castle'
      : san.includes('O-O#')
      ? 'short castle checkmate'
      : san.includes('O-O+')
      ? 'short castle check'
      : san.includes('O-O')
      ? 'short castle'
      : san
          .split('')
          .map(c => {
            if (c == 'x') return 'takes';
            if (c == '+') return 'check';
            if (c == '#') return 'checkmate';
            if (c == '=') return 'promotes to';
            if (c == '@') return 'at';
            const code = c.charCodeAt(0);
            if (code > 48 && code < 58) return c; // 1-8
            if (code > 96 && code < 105) return c.toUpperCase();
            return charRole(c) || c;
          })
          .join(' ')
          .replace(/^A /, 'A, ') // "A takes" & "A 3" are mispronounced
          .replace(/(\d) E (\d)/, '$1,E $2') // Strings such as 1E5 are treated as scientific notation
          .replace(/C /, 'c ') // Capital C is pronounced as "degrees celsius" when it comes after a number (e.g. R8c3)
          .replace(/F /, 'f ') // Capital F is pronounced as "degrees fahrenheit" when it comes after a number (e.g. R8f3)
          .replace(/(\d) H (\d)/, '$1H$2'); // "H" is pronounced as "hour" when it comes after a number with a space (e.g. Rook 5 H 3)
    this.say(text, cut);
  }

  preloadBoardSounds() {
    if (this.enabled() && this.theme !== 'music')
      for (const name of ['move', 'capture', 'check', 'genericNotify'])
        this.load(name, this.themePath(name), true);
  }

  themePath(name: Name, theme?: string) {
    return `${this.baseUrl}/${theme ?? this.theme}/${name[0].toUpperCase() + name.slice(1)}`;
  }
})();
