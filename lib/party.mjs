import {initialUndercover,pendingUndercover,applyUndercover,timeoutUndercover,undercoverView,undercoverSchema} from './games/undercover.mjs';
import {initialLiarsdice,pendingLiarsdice,applyLiarsdice,timeoutLiarsdice,liarsdiceView,liarsdiceSchema} from './games/liarsdice.mjs';
import {initialCodenames,pendingCodenames,applyCodenames,timeoutCodenames,codenamesView,codenamesSchema} from './games/codenames.mjs';
import {initialSpyfall,pendingSpyfall,applySpyfall,timeoutSpyfall,spyfallView,spyfallSchema} from './games/spyfall.mjs';
import {GAME_RULES} from './rules.mjs';

const games={
 undercover:{initial:initialUndercover,pending:pendingUndercover,apply:applyUndercover,timeout:timeoutUndercover,view:undercoverView,schema:undercoverSchema},
 liarsdice:{initial:initialLiarsdice,pending:pendingLiarsdice,apply:applyLiarsdice,timeout:timeoutLiarsdice,view:liarsdiceView,schema:()=>liarsdiceSchema},
 codenames:{initial:initialCodenames,pending:pendingCodenames,apply:applyCodenames,timeout:timeoutCodenames,view:codenamesView,schema:codenamesSchema},
 spyfall:{initial:initialSpyfall,pending:pendingSpyfall,apply:applySpyfall,timeout:timeoutSpyfall,view:spyfallView,schema:spyfallSchema},
};
export const PARTY_KINDS=Object.keys(games);
export const isParty=m=>Object.hasOwn(games,typeof m==='string'?m:m.kind);
export const initialParty=(kind,options)=>games[kind].initial(options);
export const pendingParty=g=>games[g.game].pending(g);
export const applyParty=(g,seat,result)=>games[g.game].apply(g,seat,result);
export const timeoutParty=(g,seat)=>games[g.game].timeout(g,seat);
export const partyPhase=g=>`${g.round}:${g.phase}:${g.log.length}`;
export const partySchema=(g,seat)=>games[g.game].schema(g,seat);
export function partyView(g,seat=null,reveal=false) {
 return {...games[g.game].view(g,seat,reveal),rules:GAME_RULES[g.game]};
}
