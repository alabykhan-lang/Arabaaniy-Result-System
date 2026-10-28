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
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.LinearInterpolator;
import android.view.animation.OvershootInterpolator;
import android.graphics.drawable.GradientDrawable;
import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
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
    private Intent pendingPickIntent;
    private File pendingCameraFile;
    private boolean printInProgress = false;
    private boolean reportCardPrintInProgress = false;
    // Splash shown over the WebView until the page has painted its first frame.
    private View splash;
    private boolean splashDismissed = false;
    private boolean splashQueued = false;
    private long splashStart = 0L;
    private boolean pagePainted = false;
    private static final long SPLASH_MIN_MS = 5200;   // stay up at least this long
    private static final long SPLASH_HARD_MS = 9000;  // ...but never longer than this
    private static final long SPLASH_PAINT_GRACE_MS = 1500; // then leave even if unpainted
    private final Handler splashHandler = new Handler(Looper.getMainLooper());

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
        // The page starts white until the first paint, which flashes on every launch.
        // Paint the WebView canvas in the school's navy so the launch looks continuous.
        webView.setBackgroundColor(schoolNavy);

        // A branded splash sits on top of the WebView instead of a bare navy screen:
        // the school crest flips in, breathes once, then fades away as the portal paints.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(schoolNavy);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(buildSplash(schoolNavy), new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        // The splash is a fixed 5-second show; the portal may finish sooner, but it waits.
        splashHandler.postDelayed(() -> dismissSplash(splashStart == 0L || splashDismissed), SPLASH_HARD_MS);

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
        webView.addJavascriptInterface(new SplashBridge(), "AndroidSplash");

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
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                // Commit is not paint: the page can commit as a blank frame. Wait for the
                // page's own painted() signal, and only force it after a short grace.
                if (pagePainted) {
                    dismissSplash();
                } else {
                    splashHandler.postDelayed(MainActivity.this::dismissSplash, SPLASH_PAINT_GRACE_MS);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (pagePainted) {
                    dismissSplash();
                } else {
                    splashHandler.postDelayed(() -> dismissSplash(true), SPLASH_PAINT_GRACE_MS);
                }
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
                            pendingPickIntent = contentIntent;
                            startActivityForResult(cameraIntent, FILE_PICKER_REQUEST);
                            return true;
                        } catch (Exception ignored) {
                            pendingPickIntent = null;
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
            if (resultCode != RESULT_OK && pendingPickIntent != null) {
                // The camera gave nothing back. Rather than leaving the user stuck, open the
                // gallery picker on the same tap.
                Intent fallback = pendingPickIntent;
                pendingPickIntent = null;
                pendingCameraUri = null;
                pendingCameraFile = null;
                try {
                    startActivityForResult(fallback, FILE_PICKER_REQUEST);
                    return;
                } catch (Exception ignored) {
                    // fall through and report
                }
            }
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
            pendingPickIntent = null;
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

    /**
     * The page calls AndroidSplash.painted() on its first real frame. Until then the
     * splash stays, so the transition is splash → page with no white canvas between.
     */
    private class SplashBridge {
        @JavascriptInterface
        public void painted() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    pagePainted = true;
                    dismissSplash();
                }
            });
        }
    }

    private View ring(float strokeDp) {
        View v = new View(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setStroke((int) (strokeDp * getResources().getDisplayMetrics().density),
                Color.parseColor("#88C99A3B"));
        v.setBackground(g);
        v.setAlpha(0f);
        return v;
    }

    /** Navy backdrop, crest on a gold halo, name underneath: a ~5 second show, not a flicker. */
    private View buildSplash(int schoolNavy) {
        splashStart = SystemClock.uptimeMillis();

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(schoolNavy);

        float d = getResources().getDisplayMetrics().density;

        FrameLayout wrap = new FrameLayout(this);
        View ringOuter = ring(1.5f);
        View ringInner = ring(3f);
        int ringSize = (int) (260 * d);
        wrap.addView(ringOuter, new FrameLayout.LayoutParams(ringSize, ringSize, Gravity.CENTER));
        wrap.addView(ringInner, new FrameLayout.LayoutParams((int) (190 * d), (int) (190 * d), Gravity.CENTER));

        ImageView crest = new ImageView(this);
        crest.setImageResource(R.drawable.school_logo);
        int crestSize = (int) (128 * d);
        wrap.addView(crest, new FrameLayout.LayoutParams(crestSize, crestSize, Gravity.CENTER));
        box.addView(wrap, new LinearLayout.LayoutParams(ringSize, ringSize));

        TextView name = new TextView(this);
        name.setText("ARRABAANIY STANDARD SCHOOL");
        name.setTextColor(Color.parseColor("#F1D9A0"));
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setLetterSpacing(0.16f);
        name.setTextSize(12f);
        name.setGravity(Gravity.CENTER);
        name.setAlpha(0f);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nameParams.topMargin = (int) (6 * d);
        box.addView(name, nameParams);

        TextView tagline = new TextView(this);
        tagline.setText("RESULT MANAGEMENT SYSTEM");
        tagline.setTextColor(Color.parseColor("#8FA3C8"));
        tagline.setLetterSpacing(0.22f);
        tagline.setTextSize(9.5f);
        tagline.setGravity(Gravity.CENTER);
        tagline.setAlpha(0f);
        LinearLayout.LayoutParams tagParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        tagParams.topMargin = (int) (10 * d);
        box.addView(tagline, tagParams);

        splash = box;

        // Crest: turned away on the Z axis, flipped to face the user, settling with a spring.
        crest.setCameraDistance(9000 * d);
        crest.setRotationY(-150f);
        crest.setRotation(-9f);
        crest.setAlpha(0f);
        crest.setScaleX(0.55f);
        crest.setScaleY(0.55f);

        ObjectAnimator flip = ObjectAnimator.ofFloat(crest, "rotationY", -150f, 0f);
        flip.setDuration(900);
        flip.setInterpolator(new DecelerateInterpolator(1.6f));
        ObjectAnimator tilt = ObjectAnimator.ofFloat(crest, "rotationZ", -9f, 0f);
        tilt.setDuration(900);
        tilt.setInterpolator(new DecelerateInterpolator());
        ObjectAnimator fadeIn = ObjectAnimator.ofFloat(crest, "alpha", 0f, 1f);
        fadeIn.setDuration(420);
        ObjectAnimator growX = ObjectAnimator.ofFloat(crest, "scaleX", 0.55f, 1f);
        ObjectAnimator growY = ObjectAnimator.ofFloat(crest, "scaleY", 0.55f, 1f);
        for (Animator a : new Animator[]{growX, growY}) {
            a.setDuration(820);
            a.setInterpolator(new OvershootInterpolator(1.8f));
        }

        // Halo: two rings that swell out of the crest and dissolve.
        ObjectAnimator ringOut = swell(ringOuter, 2100, 0);
        ObjectAnimator ringIn = swell(ringInner, 1700, 260);

        // Name and tagline rise in behind the crest.
        ObjectAnimator nameIn = ObjectAnimator.ofFloat(name, "alpha", 0f, 1f);
        nameIn.setDuration(600);
        nameIn.setStartDelay(680);
        ObjectAnimator nameUp = ObjectAnimator.ofFloat(name, "translationY", 22f * d, 0f);
        nameUp.setDuration(600);
        nameUp.setStartDelay(680);
        nameUp.setInterpolator(new DecelerateInterpolator());
        ObjectAnimator tagIn = ObjectAnimator.ofFloat(tagline, "alpha", 0f, 1f);
        tagIn.setDuration(600);
        tagIn.setStartDelay(980);

        // Slow breathing while the portal loads, so the screen is never static.
        ObjectAnimator breathe = ObjectAnimator.ofFloat(crest, "scaleX", 1f, 1.05f);
        breathe.setDuration(1500);
        breathe.setStartDelay(900);
        breathe.setRepeatMode(ValueAnimator.REVERSE);
        breathe.setRepeatCount(ValueAnimator.INFINITE);
        breathe.setInterpolator(new AccelerateDecelerateInterpolator());
        ObjectAnimator breatheY = breathe.clone();
        breatheY.setTarget(crest);
        breatheY.setPropertyName("scaleY");

        for (Animator a : new Animator[]{flip, tilt, fadeIn, growX, growY, ringOut, ringIn,
                nameIn, nameUp, tagIn, breathe, breatheY}) {
            a.start();
        }
        return box;
    }

    private ObjectAnimator swell(View target, long duration, long delay) {
        target.setScaleX(0.45f);
        target.setScaleY(0.45f);
        target.setAlpha(0.85f);
        ObjectAnimator scaleX = ObjectAnimator.ofFloat(target, "scaleX", 0.45f, 1.45f);
        ObjectAnimator scaleY = ObjectAnimator.ofFloat(target, "scaleY", 0.45f, 1.45f);
        ObjectAnimator fade = ObjectAnimator.ofFloat(target, "alpha", 0.85f, 0f);
        for (Animator a : new Animator[]{scaleX, scaleY, fade}) {
            a.setDuration(duration);
            a.setStartDelay(delay);
            a.setInterpolator(new LinearInterpolator());
            a.start();
        }
        return scaleX;
    }

    private void dismissSplash() {
        dismissSplash(false);
    }

    /** Leaves after the fixed show, or straight away when the hard cap has passed. */
    private void dismissSplash(boolean force) {
        if (splash == null || splashDismissed) return;
        long elapsed = SystemClock.uptimeMillis() - splashStart;
        if (!force && elapsed < SPLASH_MIN_MS) {
            if (!splashQueued) {
                splashQueued = true;
                splashHandler.postDelayed(() -> dismissSplash(false), SPLASH_MIN_MS - elapsed);
            }
            return;
        }
        splashDismissed = true;
        splash.animate()
                .alpha(0f)
                .scaleX(1.12f)
                .scaleY(1.12f)
                .setDuration(520)
                .setInterpolator(new DecelerateInterpolator())
                .setListener(new AnimatorListenerAdapter() {
                    @Override
                    public void onAnimationEnd(Animator animation) {
                        if (splash != null && splash.getParent() != null) {
                            ((FrameLayout) splash.getParent()).removeView(splash);
                        }
                        splash = null;
                    }
                })
                .start();
    }
}
