package ru.zvyak.brooklynbowl.waiter;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Native delivery for urgent waiter calls when the app is in background. */
public class WaiterFirebaseMessagingService extends FirebaseMessagingService {
  private static final String CHANNEL = "bb_waiter_urgent";
  @Override public void onMessageReceived(RemoteMessage message) {
    String title = value(message, "title", "BrooklynBowl");
    String body = value(message, "body", "Новая задача");
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(CHANNEL, "Срочные вызовы BrooklynBowl", NotificationManager.IMPORTANCE_HIGH);
      channel.enableVibration(true); manager.createNotificationChannel(channel);
    }
    Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName()); if (intent == null) return;
    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent open = PendingIntent.getActivity(this, 101, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(getApplicationInfo().icon).setContentTitle(title).setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body)).setPriority(NotificationCompat.PRIORITY_MAX).setCategory(NotificationCompat.CATEGORY_CALL).setAutoCancel(true).setVibrate(new long[]{0, 250, 120, 450}).setContentIntent(open).setFullScreenIntent(open, true);
    manager.notify((int) (System.currentTimeMillis() & 0xfffffff), notification.build());
  }
  private String value(RemoteMessage message, String key, String fallback) { String result = message.getData().get(key); return result == null || result.isEmpty() ? fallback : result; }
}
