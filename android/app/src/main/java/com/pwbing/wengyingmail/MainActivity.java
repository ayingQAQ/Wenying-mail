package com.pwbing.wengyingmail;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.provider.DocumentsContract;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
 private static final int SAVE_FILE=41;
 private WebView web;
 private ProgressBar progress;
 private LinearLayout errorPanel;
 private TextView errorText;
 private Download pending;
 private boolean downloading=false;
 private volatile boolean destroyed=false;
 private volatile HttpURLConnection transfer;
 private final ExecutorService io=Executors.newSingleThreadExecutor();
 private static final class Download {
  final String url,mime,name;
  Download(String url,String mime,String name){this.url=url;this.mime=mime;this.name=name;}
 }
 private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
 @SuppressLint("SetJavaScriptEnabled")
 @Override public void onCreate(Bundle state){
  super.onCreate(state);
  if(state!=null&&UrlPolicy.download(state.getString("pendingDownloadUrl")))pending=new Download(state.getString("pendingDownloadUrl"),state.getString("pendingDownloadMime","application/octet-stream"),UrlPolicy.filename(state.getString("pendingDownloadName")));
  FrameLayout root=new FrameLayout(this);root.setBackgroundColor(getColor(R.color.window_background));
  web=new WebView(this);web.setBackgroundColor(getColor(R.color.window_background));root.addView(web,new FrameLayout.LayoutParams(-1,-1));
  progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);progress.setMax(100);root.addView(progress,new FrameLayout.LayoutParams(-1,dp(3),Gravity.TOP));
  errorPanel=new LinearLayout(this);errorPanel.setOrientation(LinearLayout.VERTICAL);errorPanel.setGravity(Gravity.CENTER);errorPanel.setPadding(dp(24),dp(24),dp(24),dp(24));errorPanel.setBackgroundColor(getColor(R.color.window_background));
  errorText=new TextView(this);errorText.setTextColor(getColor(R.color.text_primary));errorText.setTextSize(17);errorText.setGravity(Gravity.CENTER);errorPanel.addView(errorText);
  Button retry=new Button(this);retry.setText("重新连接");retry.setOnClickListener(v->{errorPanel.setVisibility(View.GONE);web.loadUrl(UrlPolicy.HOME);});errorPanel.addView(retry);errorPanel.setVisibility(View.GONE);root.addView(errorPanel,new FrameLayout.LayoutParams(-1,-1));
  setContentView(root);
  if(Build.VERSION.SDK_INT>=30)getWindow().setDecorFitsSystemWindows(false);
  root.setOnApplyWindowInsetsListener((v,insets)->{
   if(Build.VERSION.SDK_INT>=30){android.graphics.Insets area=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());v.setPadding(area.left,area.top,area.right,area.bottom);return WindowInsets.CONSUMED;}
   v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets.consumeSystemWindowInsets();
  });
  if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,this::goBack);
  WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setSafeBrowsingEnabled(true);settings.setMediaPlaybackRequiresUserGesture(true);settings.setSupportMultipleWindows(true);settings.setJavaScriptCanOpenWindowsAutomatically(false);settings.setBuiltInZoomControls(true);settings.setDisplayZoomControls(false);settings.setUserAgentString(settings.getUserAgentString()+" WengyingMail/1.0");
  CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
  WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0);
  web.setWebViewClient(new WebViewClient(){
   @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
    if(!request.isForMainFrame())return !UrlPolicy.external(request.getUrl().toString());
    return navigate(request.getUrl().toString(),request.hasGesture());
   }
   @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon){progress.setVisibility(View.VISIBLE);}
   @Override public void onPageFinished(WebView view,String url){progress.setVisibility(View.GONE);CookieManager.getInstance().flush();}
   @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame())showError("暂时无法连接邮局\n请检查网络后重试");}
   @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response){if(request.isForMainFrame()&&response.getStatusCode()>=500)showError("邮局暂时不可用\n请稍后重试");}
   @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){handler.cancel();showError("无法验证网站的安全连接\n请检查设备时间或稍后重试");}
   @Override public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){root.removeView(view);view.destroy();web=null;showError("页面已停止运行\n请重新打开邮局");retry.setOnClickListener(v->recreate());return true;}
  });
  web.setWebChromeClient(new WebChromeClient(){
   @Override public void onProgressChanged(WebView view,int value){progress.setProgress(value);}
   @Override public void onPermissionRequest(PermissionRequest request){request.deny();}
   @Override public boolean onCreateWindow(WebView view,boolean dialog,boolean userGesture,Message result){
    if(!userGesture)return false;
    WebView popup=new WebView(MainActivity.this);
    popup.setWebViewClient(new WebViewClient(){@Override public boolean shouldOverrideUrlLoading(WebView child,WebResourceRequest req){String url=req.getUrl().toString();if(UrlPolicy.trusted(url))web.loadUrl(url);else openExternal(url);child.post(child::destroy);return true;}});
    ((WebView.WebViewTransport)result.obj).setWebView(popup);result.sendToTarget();return true;
   }
  });
  web.setDownloadListener((url,agent,disposition,mime,length)->beginDownload(url,disposition,mime));
  if(state==null||web.restoreState(state)==null)web.loadUrl(UrlPolicy.HOME);
 }
 private boolean navigate(String url,boolean gesture){if(UrlPolicy.trusted(url))return false;if(gesture)openExternal(url);return true;}
 private void openExternal(String url){if(!UrlPolicy.external(url)){toast("不支持打开此链接");return;}try{Intent intent=new Intent(Intent.ACTION_VIEW,Uri.parse(url));intent.addCategory(Intent.CATEGORY_BROWSABLE);startActivity(intent);}catch(ActivityNotFoundException error){toast("没有可用的浏览器");}}
 private void showError(String text){if(destroyed)return;progress.setVisibility(View.GONE);errorText.setText(text);errorPanel.setVisibility(View.VISIBLE);}
 private void toast(String value){Toast.makeText(this,value,Toast.LENGTH_SHORT).show();}
 private void goBack(){if(web!=null&&web.canGoBack()&&errorPanel.getVisibility()!=View.VISIBLE)web.goBack();else finish();}
 // Android 13+ uses the native OnBackInvokedDispatcher registered above.
 @SuppressLint("GestureBackNavigation")
 @Override public void onBackPressed(){goBack();}
 @Override protected void onSaveInstanceState(Bundle state){if(web!=null)web.saveState(state);if(pending!=null){state.putString("pendingDownloadUrl",pending.url);state.putString("pendingDownloadMime",pending.mime);state.putString("pendingDownloadName",pending.name);}super.onSaveInstanceState(state);}
 @Override protected void onPause(){if(web!=null)web.onPause();CookieManager.getInstance().flush();super.onPause();}
 @Override protected void onResume(){super.onResume();if(web!=null)web.onResume();}
 private void beginDownload(String url,String disposition,String mime){
  if(!UrlPolicy.download(url)){toast("仅支持下载邮局附件和邮件原件");return;}
  if(downloading||pending!=null){toast("请先完成当前文件的保存");return;}
  String type=mime!=null&&mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")?mime:"application/octet-stream";
  pending=new Download(url,type,UrlPolicy.filename(URLUtil.guessFileName(url,disposition,type)));
  Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType(type);intent.putExtra(Intent.EXTRA_TITLE,pending.name);
  try{startActivityForResult(intent,SAVE_FILE);}catch(ActivityNotFoundException error){pending=null;toast("未找到系统文件保存器");}
 }
 @Override protected void onActivityResult(int request,int result,Intent data){
  super.onActivityResult(request,result,data);if(request!=SAVE_FILE)return;
  Download job=pending;pending=null;if(result!=RESULT_OK||data==null||data.getData()==null||job==null)return;
  Uri destination=data.getData();String cookie=CookieManager.getInstance().getCookie(job.url);String agent=web==null?"WengyingMail/1.0":web.getSettings().getUserAgentString();downloading=true;toast("正在保存文件…");
  io.execute(()->saveFile(job,destination,cookie,agent));
 }
 private void saveFile(Download job,Uri destination,String cookie,String agent){
  boolean success=false;HttpURLConnection connection=null;
  try{
   connection=(HttpURLConnection)new URL(job.url).openConnection();transfer=connection;connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(20000);connection.setRequestProperty("User-Agent",agent);connection.setRequestProperty("Accept-Encoding","identity");if(cookie!=null)connection.setRequestProperty("Cookie",cookie);
   if(connection.getResponseCode()!=200)throw new IOException("DOWNLOAD_REJECTED");
   long expected=connection.getContentLengthLong(),limit=32L*1024*1024;if(expected>limit)throw new IOException("LIMIT");
   try(InputStream input=connection.getInputStream();OutputStream output=getContentResolver().openOutputStream(destination,"w")){
    if(output==null)throw new IOException("DESTINATION");byte[] buffer=new byte[32768];long count=0;int size;
    while((size=input.read(buffer))!=-1){if(destroyed||Thread.currentThread().isInterrupted())throw new IOException("CANCELLED");count+=size;if(count>limit)throw new IOException("LIMIT");output.write(buffer,0,size);}
    if(expected>=0&&count!=expected)throw new IOException("TRUNCATED");output.flush();
   }success=true;
  }catch(Exception ignored){try{DocumentsContract.deleteDocument(getContentResolver(),destination);}catch(Exception cleanupIgnored){}}
  finally{if(connection!=null)connection.disconnect();transfer=null;boolean saved=success;runOnUiThread(()->{downloading=false;if(!destroyed)toast(saved?"文件已保存":"保存失败，请检查网络和登录状态后重试");});}
 }
 @Override protected void onDestroy(){destroyed=true;io.shutdownNow();HttpURLConnection connection=transfer;if(connection!=null)connection.disconnect();if(web!=null){web.stopLoading();web.destroy();web=null;}super.onDestroy();}
}
