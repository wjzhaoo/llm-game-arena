/* Runs before styles to avoid flashing the wrong theme. No network access. */
(()=>{
 const KEY='arena-theme-preference',valid=v=>['system','light','dark'].includes(v);
 let preference='system';try{const value=localStorage.getItem(KEY);if(valid(value))preference=value}catch{}
 const media=typeof matchMedia==='function'?matchMedia('(prefers-color-scheme: dark)'):null;
 function apply(){const theme=preference==='system'?(media?.matches?'dark':'light'):preference;document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;const control=document.getElementById('themePreference');if(control)control.value=preference}
 function set(value){if(!valid(value))return;preference=value;try{localStorage.setItem(KEY,value)}catch{}apply()}
 media?.addEventListener?.('change',()=>{if(preference==='system')apply()});
 addEventListener('storage',event=>{if(event.key===KEY){preference=valid(event.newValue)?event.newValue:'system';apply()}});
 globalThis.ArenaTheme={get preference(){return preference},set};apply();
})();
