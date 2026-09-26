Opening Excalidraw Visualizer on a Mac
======================================

Excalidraw Visualizer is currently distributed without an Apple Developer ID
signature or notarization. macOS therefore blocks the first launch even though
the app was built from this public repository.

Install and open it
-------------------

1. Drag Excalidraw Visualizer into the Applications folder in this window.
2. Open it from Applications. When macOS says it cannot verify the app or that
   the app was not opened, choose Done. Do not move the app to the Trash.
3. Open System Settings > Privacy & Security, scroll to Security, and click
   Open Anyway beside Excalidraw Visualizer. Confirm with Open.

The Open Anyway button appears only after the blocked launch in step 2.

If macOS says the app is damaged
--------------------------------

Do not move it to the Trash. In Terminal, run:

    xattr -dr com.apple.quarantine "/Applications/Excalidraw Visualizer.app"

Then open the app normally. Do not disable Gatekeeper system-wide.

Apple-silicon Macs need the arm64 disk image. Intel Macs need the x64 disk
image. Excalidraw Visualizer requires macOS 13 Ventura or later.

Source and help:
https://github.com/magnuslandahl/ExcalidrawVisualizer
