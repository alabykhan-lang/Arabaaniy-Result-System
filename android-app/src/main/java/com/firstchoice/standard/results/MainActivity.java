package com.firstchoice.standard.results;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Build;
import android.graphics.Color;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    // Set your production portal URL here (e.g. deployed on Vercel)
    private static final String PORTAL_URL = "https://arabaaniy-result-system.vercel.app/portal_core.html";
    private static final int FILE_PICKER_REQUEST = 1001;

    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;
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
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
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
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_PICKER_REQUEST);
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
        if (webView != null && printInProgress) {
            final boolean restoreReportCard = reportCardPrintInProgress;
            printInProgress = false;
            reportCardPrintInProgress = false;
            webView.postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (webView == null) return;
                    String script = "(function(){"
                        + "try{window.dispatchEvent(new Event('afterprint'));}catch(e){}"
                        + (restoreReportCard
                            ? "try{var p=document.getElementById('page-card');if(p){document.querySelectorAll('.page').forEach(function(x){x.classList.remove('active','print-active');});p.classList.add('active','print-active');var n=document.getElementById('ni-card');if(n){document.querySelectorAll('.ni').forEach(function(x){x.classList.remove('active');});n.classList.add('active');}try{sessionStorage.setItem('wts_page','card');}catch(e){}}}catch(e){}"
                            : "")
                        + "})();";
                    webView.evaluateJavascript(script, null);
                }
            }, 250);
        }
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
            Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            fileUploadCallback.onReceiveValue(result);
            fileUploadCallback = null;
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

    private void printCurrentPage(final boolean reportCard) {
        if (webView == null) return;

        // Native WebView printing does not reliably emit browser beforeprint,
        // so trigger it explicitly. The portal uses it to fit each report card
        // cleanly onto one A4 page.
        webView.evaluateJavascript(
            "(function(){try{window.dispatchEvent(new Event('beforeprint'));}catch(e){}})();",
            null
        );

        PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
        String jobName = getString(R.string.app_name) + (reportCard ? " Report Card" : " Print");
        PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);

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
            value -> printCurrentPage("true".equalsIgnoreCase(String.valueOf(value)))
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
