/* Runs before styles to avoid flashing the wrong theme. No network access. */
(()=>{
 const valid=v=>['system','light','dark'].includes(v);
 let preference='system';try{localStorage.removeItem('arena-theme-preference')}catch{}
 const media=typeof matchMedia==='function'?matchMedia('(prefers-color-scheme: dark)'):null;
 function apply(){const theme=preference==='system'?(media?.matches?'dark':'light'):preference;document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;const control=document.getElementById('themePreference');if(control)control.value=preference}
 function set(value){if(!valid(value))return;preference=value;apply()}
 media?.addEventListener?.('change',()=>{if(preference==='system')apply()});
 globalThis.ArenaTheme={get preference(){return preference},set};apply();
})();
