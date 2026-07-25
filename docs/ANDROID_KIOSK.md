# Android kiosk APK

The APK is built automatically by GitHub Actions and is available in the workflow artifacts.

The app bundles the complete web interface and all project-local menu images into the APK. It opens in an immersive full-screen WebView and uses the production server only for API data: menu updates, terminal settings, orders, and waiter calls. Android only permits an app to prevent leaving it when the tablet is provisioned as a dedicated device (Device Owner). The included app activates Lock Task automatically when it has this permission; otherwise it remains full-screen but Android navigation is still available.

## Dedicated-device setup

1. Install the APK on a reset Android tablet.
2. Enrol the tablet in an MDM, or set this package as Device Owner using Android provisioning / ADB.
3. Allow `ru.zvyak.zakaz` for Lock Task mode in the MDM policy.
4. Launch the app. It will enter kiosk mode automatically.

For testing without MDM, Android screen pinning can be enabled in the device settings. It is weaker than Device Owner mode and can be exited with the device PIN.
