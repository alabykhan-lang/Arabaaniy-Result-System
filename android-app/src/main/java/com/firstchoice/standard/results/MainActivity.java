package com.firstchoice.standard.results;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.os.Build;
import android.provider.MediaStore;
import android.graphics.Color;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;

public class MainActivity extends Activity {
    // Set your production portal URL here (e.g. deployed on Vercel)
    private static final String PORTAL_URL = "https://arabaaniy-result-system.vercel.app/portal_core.html?app=131";
    private static final int FILE_PICKER_REQUEST = 1001;

    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;
    private Uri pendingCameraUri;
    private File pendingCameraFile;
    private boolean printInProgress = false;
    private boolean reportCardPrintInProgress = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep the Android system bars inside the school brand and keep
        // notification/home icons readable on modern edge-to-edge Android.
        Window window = getWindow();
        int schoolNavy = Color.rgb(19, 37, 74);
        window.setStatusBarColor(schoolNavy);
        window.setNavigationBarColor(schoolNavy);
        window.getDecorView().setSystemUiVisibility(0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && window.getInsetsController() != null) {
            window.getInsetsController().setSystemBarsAppearance(
                0,
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            );
        }

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setTextZoom(100);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.addJavascriptInterface(new PrintBridge(), "AndroidPrint");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) {
                    return false;
                }
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                view.evaluateJavascript(
                    "(function(){if(!window.__wtsAndroidPrint){window.__wtsAndroidPrint=true;window.print=function(){AndroidPrint.printPage();};}})();",
                    null
                );
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
                fileUploadCallback = callback;
                pendingCameraUri = null;
                pendingCameraFile = null;
                Intent contentIntent = params.createIntent();
                // capture="environment" asks for the camera. params.createIntent() only ever
                // builds a document picker, which is why Take Photo opened the gallery.
                // Launch the camera directly: routing it through a chooser drops the
                // content:// write grant, so the camera opens and immediately bounces back.
                if (params.isCaptureEnabled() && acceptsImages(params)) {
                    Intent cameraIntent = buildCameraIntent();
                    if (cameraIntent != null) {
                        try {
                            startActivityForResult(cameraIntent, FILE_PICKER_REQUEST);
                            return true;
                        } catch (Exception ignored) {
                            // fall through to the picker
                        }
                    }
                }
                try {
                    startActivityForResult(contentIntent, FILE_PICKER_REQUEST);
                } catch (Exception ex) {
                    fileUploadCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                request.addRequestHeader("User-Agent", userAgent);
                request.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "school-result-download");
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                manager.enqueue(request);
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(PORTAL_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_PICKER_REQUEST && fileUploadCallback != null) {
            Uri[] result;
            if (resultCode == RESULT_OK && (data == null || data.getData() == null) && pendingCameraUri != null) {
                // the camera app wrote the photo to our content:// Uri
                result = new Uri[]{pendingCameraUri};
            } else {
                result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
            fileUploadCallback.onReceiveValue(result);
            fileUploadCallback = null;
            pendingCameraUri = null;
            pendingCameraFile = null;
            if (resultCode != RESULT_OK) {
                // say so in the page instead of silently dropping the user back on the form
                webView.evaluateJavascript(
                    "(function(){try{if(window.showToast)window.showToast('No photo was returned. Use From Gallery instead.','error');}catch(e){}})();",
                    null
                );
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private boolean acceptsImages(WebChromeClient.FileChooserParams params) {
        String[] types = params.getAcceptTypes();
        if (types == null || types.length == 0) return true;
        for (String type : types) {
            if (type != null && type.toLowerCase().contains("image")) return true;
        }
        return false;
    }

    private Intent buildCameraIntent() {
        try {
            pendingCameraFile = CameraFileProvider.newOutputFile(this);
            pendingCameraUri = CameraFileProvider.uriFor(pendingCameraFile);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("photo", pendingCameraUri));
            if (intent.resolveActivity(getPackageManager()) == null) return null;
            return intent;
        } catch (Exception ex) {
            return null;
        }
    }

    private void printCurrentPage(final boolean reportCard) {
        if (webView == null) return;

        // Ensure report cards fit A4 portrait cleanly before handing to Android Print Spooler
        webView.evaluateJavascript(
            "(function(){try{window.dispatchEvent(new Event('beforeprint'));}catch(e){}})();",
            null
        );

        PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
        String jobName = getString(R.string.app_name) + (reportCard ? " Report Card" : " Print");
        final PrintDocumentAdapter originalAdapter = webView.createPrintDocumentAdapter(jobName);

        PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
            @Override
            public void onStart() {
                originalAdapter.onStart();
            }

            @Override
            public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes,
                                 CancellationSignal cancellationSignal,
                                 LayoutResultCallback callback, Bundle extras) {
                originalAdapter.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
            }

            @Override
            public void onWrite(PageRange[] pages, ParcelFileDescriptor destination,
                                CancellationSignal cancellationSignal,
                                WriteResultCallback callback) {
                originalAdapter.onWrite(pages, destination, cancellationSignal, callback);
            }

            @Override
            public void onFinish() {
                originalAdapter.onFinish();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        printInProgress = false;
                        reportCardPrintInProgress = false;
                        if (webView != null) {
                            webView.evaluateJavascript(
                                "(function(){try{window.dispatchEvent(new Event('afterprint'));}catch(e){}})();",
                                null
                            );
                        }
                    }
                });
            }
        };

        PrintAttributes.MediaSize mediaSize = reportCard
            ? PrintAttributes.MediaSize.ISO_A4.asPortrait()
            : PrintAttributes.MediaSize.ISO_A4.asLandscape();

        PrintAttributes attributes = new PrintAttributes.Builder()
            .setMediaSize(mediaSize)
            .setMinMargins(new PrintAttributes.Margins(0, 0, 0, 0))
            .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
            .build();

        printInProgress = true;
        reportCardPrintInProgress = reportCard;
        printManager.print(jobName, adapter, attributes);
    }

    private void detectPageAndPrint() {
        if (webView == null) return;
        webView.evaluateJavascript(
            "(function(){var p=document.getElementById('page-card');return !!(p&&(p.classList.contains('active')||p.classList.contains('print-active')));})()",
            new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    boolean isReportCard = value != null && value.replace("\"", "").trim().equalsIgnoreCase("true");
                    printCurrentPage(isReportCard);
                }
            }
        );
    }

    private class PrintBridge {
        @JavascriptInterface
        public void printPage() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    detectPageAndPrint();
                }
            });
        }
    }
}
