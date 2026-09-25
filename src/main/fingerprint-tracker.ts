export class ContentFingerprintTracker {
  #lastObserved: string | undefined
  readonly #ownWrites = new Set<string>()

  constructor(initialFingerprint?: string) {
    this.#lastObserved = initialFingerprint
  }

  markOwnWrite(contentFingerprint: string): void {
    this.#ownWrites.add(contentFingerprint)
    this.#lastObserved = contentFingerprint
  }

  shouldSuppress(contentFingerprint: string): boolean {
    if (this.#ownWrites.delete(contentFingerprint)) {
      this.#lastObserved = contentFingerprint
      return true
    }
    return contentFingerprint === this.#lastObserved
  }

  acceptExternal(contentFingerprint: string): void {
    this.#lastObserved = contentFingerprint
  }
}
