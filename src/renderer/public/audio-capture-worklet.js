/* global AudioWorkletProcessor, registerProcessor */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (output) {
      output.fill(0)
    }
    if (input?.length) {
      const copy = new Float32Array(input)
      this.port.postMessage(copy.buffer, [copy.buffer])
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
