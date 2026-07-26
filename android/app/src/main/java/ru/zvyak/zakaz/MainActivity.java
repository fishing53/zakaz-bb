package ru.zvyak.zakaz;

import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.os.Bundle;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        enterImmersiveMode();
        enterKioskModeWhenPermitted();
        showBrandSplash();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }

    private void enterImmersiveMode() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        }
    }

    private void enterKioskModeWhenPermitted() {
        DevicePolicyManager policy = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (policy != null && policy.isLockTaskPermitted(getPackageName())) {
            startLockTask();
        }
    }

    /**
     * Android's system splash only permits a small launcher drawable.  This
     * short native overlay supplies the official bundled Brooklyn Bowl wordmark
     * while the app WebView starts, so it never depends on a network request.
     */
    private void showBrandSplash() {
        ViewGroup content = findViewById(android.R.id.content);
        if (content == null) return;

        FrameLayout splash = new FrameLayout(this);
        splash.setBackgroundColor(Color.rgb(8, 8, 8));
        splash.setClickable(true);

        WebView logo = new WebView(this);
        logo.setBackgroundColor(Color.TRANSPARENT);
        logo.setVerticalScrollBarEnabled(false);
        logo.setHorizontalScrollBarEnabled(false);
        logo.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = logo.getSettings();
        settings.setJavaScriptEnabled(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        logo.loadUrl("file:///android_asset/brooklyn-bowl-logo.svg");

        int logoWidth = Math.min(dp(390), getResources().getDisplayMetrics().widthPixels - dp(72));
        int logoHeight = Math.round(logoWidth * 43.14795f / 183.84082f);
        splash.addView(logo, new FrameLayout.LayoutParams(logoWidth, logoHeight, Gravity.CENTER));
        content.addView(splash, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        logo.setAlpha(0f);
        logo.setScaleX(0.94f);
        logo.setScaleY(0.94f);
        logo.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(420).setStartDelay(90).start();
        splash.postDelayed(() -> splash.animate().alpha(0f).setDuration(280).withEndAction(
            () -> content.removeView(splash)
        ).start(), 1150);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
