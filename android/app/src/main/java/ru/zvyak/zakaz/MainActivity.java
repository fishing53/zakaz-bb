package ru.zvyak.zakaz;

import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

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
     * short native overlay supplies the real Brooklyn Bowl wordmark while the
     * WebView starts, so the guest never sees the old generic Capacitor splash.
     */
    private void showBrandSplash() {
        ViewGroup content = findViewById(android.R.id.content);
        if (content == null) return;

        FrameLayout splash = new FrameLayout(this);
        splash.setBackgroundColor(Color.rgb(8, 8, 8));
        splash.setClickable(true);

        LinearLayout logo = new LinearLayout(this);
        logo.setOrientation(LinearLayout.VERTICAL);
        logo.setGravity(Gravity.CENTER);

        TextView brooklyn = splashWord("BROOKLYN", Color.rgb(238, 234, 228), 42);
        brooklyn.setLetterSpacing(0.13f);
        TextView bowl = splashWord("BOWL", Color.rgb(237, 32, 36), 42);
        bowl.setLetterSpacing(0.20f);
        TextView caption = splashWord("KIOSK", Color.rgb(150, 150, 150), 10);
        caption.setLetterSpacing(0.32f);
        caption.setPadding(0, dp(11), 0, 0);

        logo.addView(brooklyn);
        logo.addView(bowl);
        logo.addView(caption);
        splash.addView(logo, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        ));
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

    private TextView splashWord(String text, int color, int sizeSp) {
        TextView word = new TextView(this);
        word.setText(text);
        word.setTextColor(color);
        word.setTextSize(sizeSp);
        word.setGravity(Gravity.CENTER);
        word.setIncludeFontPadding(false);
        word.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
        return word;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
