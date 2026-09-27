package com.pwbing.wengyingmail;

import java.net.URI;
import java.util.Locale;

final class UrlPolicy {
 static final String HOME="https://mail.pwbing.com/inbox";
 static final String MAIL_HOST="mail.pwbing.com";
 static final String ACCESS_HOST="soft-snow-0ef8.cloudflareaccess.com";
 private static URI parse(String value){try{return new URI(value);}catch(Exception ignored){return null;}}
 private static boolean https(URI uri){return uri!=null && "https".equalsIgnoreCase(uri.getScheme()) && uri.getRawUserInfo()==null && (uri.getPort()==-1||uri.getPort()==443);}
 static boolean trusted(String value){URI uri=parse(value);return https(uri)&&(MAIL_HOST.equalsIgnoreCase(uri.getHost())||ACCESS_HOST.equalsIgnoreCase(uri.getHost()));}
 static boolean mail(String value){URI uri=parse(value);return https(uri)&&MAIL_HOST.equalsIgnoreCase(uri.getHost());}
 static boolean download(String value){URI uri=parse(value);return mail(value)&&uri.getRawPath()!=null&&uri.getRawPath().matches("/api/(attachment/[1-9][0-9]*|email/[1-9][0-9]*/raw)")&&uri.getRawQuery()==null&&uri.getRawFragment()==null;}
 static boolean external(String value){URI uri=parse(value);return uri!=null&&uri.getHost()!=null&&uri.getRawUserInfo()==null&&("https".equalsIgnoreCase(uri.getScheme())||"http".equalsIgnoreCase(uri.getScheme()));}
 static String filename(String name){String safe=(name==null?"attachment":name).replaceAll("[\\\\/\\p{Cntrl}]","_").trim();if(safe.isEmpty()||safe.equals(".")||safe.equals(".."))safe="attachment";return safe.length()>160?safe.substring(0,160):safe;}
}
