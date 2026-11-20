package kr.goodsoldier.theologia.mobile;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.UUID;

/**
 * 폰의 폴더를 고르고(저장소 접근 프레임워크), 안의 PDF·EPUB 목록을 읽고, 열 파일을 앱 임시 공간으로 복사한다.
 * 별도의 저장소 권한이 필요 없다. 사용자가 고른 폴더에만 접근한다.
 */
@CapacitorPlugin(name = "Folder")
public class FolderPlugin extends Plugin {

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri tree = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
            // 영구 권한을 못 받아도 이번 실행에서는 읽을 수 있다
        }
        JSObject out = new JSObject();
        out.put("uri", tree.toString());
        out.put("name", treeName(tree));
        call.resolve(out);
    }

    private String treeName(Uri tree) {
        String fallback = "폴더";
        try {
            String id = DocumentsContract.getTreeDocumentId(tree);
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
            try (Cursor c = getContext().getContentResolver().query(doc,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst() && c.getString(0) != null && !c.getString(0).isEmpty()) {
                    return c.getString(0);
                }
            }
            int i = id.lastIndexOf('/');
            if (i >= 0 && i < id.length() - 1) return id.substring(i + 1);
            int j = id.lastIndexOf(':');
            if (j >= 0 && j < id.length() - 1) return id.substring(j + 1);
        } catch (Exception ignored) {
        }
        return fallback;
    }

    @PluginMethod
    public void list(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("uri 가 없습니다.");
            return;
        }
        try {
            Uri tree = Uri.parse(uriStr);
            String rootId = DocumentsContract.getTreeDocumentId(tree);
            JSArray files = new JSArray();
            walk(tree, rootId, "", files, 0);
            JSObject out = new JSObject();
            out.put("files", files);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("폴더를 읽지 못했습니다: " + e.getMessage());
        }
    }

    private void walk(Uri tree, String docId, String rel, JSArray out, int depth) {
        if (depth > 12) return;
        ContentResolver cr = getContext().getContentResolver();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] cols = new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED};
        try (Cursor c = cr.query(children, cols, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                if (id == null || name == null) continue;
                if (name.startsWith(".")) continue; // 숨김·휴지통(.trashed-…) 건너뜀
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(tree, id, rel + name + "/", out, depth + 1);
                    continue;
                }
                String lower = name.toLowerCase(Locale.ROOT);
                if (!(lower.endsWith(".pdf") || lower.endsWith(".epub"))) continue;
                JSObject f = new JSObject();
                f.put("path", rel + name);
                f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                f.put("size", c.isNull(3) ? 0L : c.getLong(3));
                f.put("modified", c.isNull(4) ? 0L : c.getLong(4));
                out.put(f);
            }
        } catch (Exception ignored) {
            // 읽을 수 없는 하위 폴더는 건너뛴다
        }
    }

    private File cacheDir() {
        File d = new File(getContext().getCacheDir(), "books");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    @PluginMethod
    public void copy(PluginCall call) {
        String uriStr = call.getString("uri");
        String name = call.getString("name", "book.pdf");
        long size = call.getData().optLong("size", 0L);
        if (uriStr == null) {
            call.reject("uri 가 없습니다.");
            return;
        }
        try {
            String ext = name.toLowerCase(Locale.ROOT).endsWith(".epub") ? ".epub" : ".pdf";
            String key = UUID.nameUUIDFromBytes(uriStr.getBytes("UTF-8")).toString();
            File dst = new File(cacheDir(), key + ext);
            if (!(dst.exists() && dst.length() > 0 && (size <= 0 || dst.length() == size))) {
                File tmp = new File(cacheDir(), key + ".part");
                try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr));
                     OutputStream os = new FileOutputStream(tmp)) {
                    if (in == null) throw new Exception("파일을 열 수 없습니다.");
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                if (dst.exists()) dst.delete();
                if (!tmp.renameTo(dst)) throw new Exception("임시 파일을 만들지 못했습니다.");
            }
            JSObject out = new JSObject();
            out.put("path", dst.getAbsolutePath());
            call.resolve(out);
        } catch (Exception e) {
            call.reject("파일을 복사하지 못했습니다: " + e.getMessage());
        }
    }

    @PluginMethod
    public void clearCache(PluginCall call) {
        File[] fs = cacheDir().listFiles();
        if (fs != null) for (File f : fs) f.delete();
        call.resolve();
    }
}
