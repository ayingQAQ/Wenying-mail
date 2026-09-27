import {addCollection} from '@iconify/vue';
// Local SVGs keep the mail interface independent of external icon requests.
const paths={
 mail:'M3 5h18v14H3z M3 6l9 7 9-7',
 inbox:'M4 4h16l2 12v4H2v-4L4 4z M2 15h6l2 3h4l2-3h6',
 star:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3z',
 'trash-2':'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
 settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
 search:'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6',
 'refresh-cw':'M20 8a8 8 0 1 0 0 8 M20 3v5h-5',
 moon:'M20 15A8.5 8.5 0 0 1 9 4a8.5 8.5 0 1 0 11 11',
 sun:'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
 'arrow-right':'M4 12h16 M14 6l6 6-6 6','arrow-left':'M20 12H4 M10 6l-6 6 6 6',
 copy:'M9 8h11v13H9z M15 8V3H4v13h5',pin:'M8 3h8 M9 3v6l-3 4v2h12v-2l-3-4V3 M12 15v6',
 'chevron-down':'m6 9 6 6 6-6','panel-left':'M3 4h18v16H3z M9 4v16',
 'key-round':'M15 3a6 6 0 0 0-5.6 8.2L3 17.6V21h3.4v-3H10v-3l2.8-2.4A6 6 0 1 0 15 3z M16 7h.01',
 'mail-open':'m3 9 9-6 9 6v12H3V9z M3 9l9 7 9-7',activity:'M2 12h5l3-9 4 18 3-9h5',
 shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z M8 12l3 3 5-6',
 users:'M15 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M3 21v-3a6 6 0 0 1 12 0v3 M17 4a4 4 0 0 1 0 8 M19 15a5 5 0 0 1 3 6',
 mails:'M3 8h15v13H3z M3 9l7.5 6L18 9 M7 3h15v13',
 'sliders-horizontal':'M3 6h8 M15 6h6 M3 18h3 M10 18h11 M11 3v6 M6 15v6 M3 12h14 M21 12h-1 M17 9v6',
};
addCollection({prefix:'mail-ui',width:24,height:24,icons:Object.fromEntries(Object.entries(paths).map(([name,d])=>[name,{body:`<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`}]))});
