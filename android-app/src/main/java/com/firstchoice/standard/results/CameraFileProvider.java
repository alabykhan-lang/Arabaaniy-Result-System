package com.firstchoice.standard.results;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Minimal file provider so a camera app can write the photo it takes into this app's
 * cache. The app has no AndroidX dependency, and passing a file:// Uri to another app
 * throws FileUriExposedException on modern Android, so a content:// Uri is required.
 *
 * Only files directly inside cacheDir/camera are served, and the provider is not
 * exported, so no other app can read or write anything else.
 */
public class CameraFileProvider extends ContentProvider {

    public static final String AUTHORITY = "com.arrabaaniy.standard.results.camera";
    private static final String FOLDER = "camera";

    public static File newOutputFile(Context context) throws Exception {
        File dir = new File(context.getCacheDir(), FOLDER);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new Exception("Could not create the camera folder.");
        }
        File file = File.createTempFile("photo_", ".jpg", dir);
        return file;
    }

    public static Uri uriFor(File file) {
        return Uri.parse("content://" + AUTHORITY + "/" + file.getName());
    }

    private File resolve(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.contains("/") || name.contains("..")) {
            throw new FileNotFoundException("Bad path.");
        }
        return new File(new File(getContext().getCacheDir(), FOLDER), name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = resolve(uri);
        // "rw" would also work, but the camera only needs write and the page only needs read.
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            File file = resolve(uri);
            String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
            MatrixCursor cursor = new MatrixCursor(cols, 1);
            Object[] row = new Object[cols.length];
            for (int i = 0; i < cols.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) {
                    row[i] = file.getName();
                } else if (OpenableColumns.SIZE.equals(cols[i])) {
                    row[i] = file.length();
                } else {
                    row[i] = null;
                }
            }
            cursor.addRow(row);
            return cursor;
        } catch (FileNotFoundException e) {
            return null;
        }
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
