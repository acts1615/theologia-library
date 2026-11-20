package kr.goodsoldier.theologia.mobile;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 앱 안에서 새 APK를 내려받아 설치 화면을 띄운다. 설치 확인 버튼은 안드로이드 규칙상 사용자가 직접 누른다.
 * 주소는 이 저장소(acts1615/theologia-library)의 릴리스 파일만 받는다. 설치 때 안드로이드가 같은 서명인지 다시 확인한다.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private static final String ALLOWED_PREFIX = "https://github.com/acts1615/theologia-library/releases/";

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith(ALLOWED_PREFIX)) {
            call.reject("bad-url");
            return;
        }
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(s);
            } catch (Exception ignored) { }
            call.reject("need-permission");
            return;
        }
        File dir = new File(ctx.getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File out = new File(dir, "update.apk");
        //noinspection ResultOfMethodCallIgnored
        out.delete();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            int code = c.getResponseCode();
            if (code != 200) { call.reject("http-" + code); return; }
            try (InputStream in = c.getInputStream(); FileOutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n; long total = 0;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    total += n;
                    if (total > 80L * 1024 * 1024) { call.reject("too-big"); return; }
                }
            }
            if (out.length() < 100 * 1024) { call.reject("bad-file"); return; }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", out);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            JSObject r = new JSObject();
            r.put("size", out.length());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("download-failed: " + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
