export function genStatsigId(dynamic: boolean): string {
  if (dynamic) {
    const alphaNum = "abcdefghijklmnopqrstuvwxyz0123456789";
    const alpha = "abcdefghijklmnopqrstuvwxyz";

    const useChildren = Math.random() < 0.5;
    let message: string;

    if (useChildren) {
      let rand = "";
      for (let i = 0; i < 5; i++) rand += alphaNum[Math.floor(Math.random() * alphaNum.length)];
      message = `e:TypeError: Cannot read properties of null (reading 'children['${rand}']')`;
    } else {
      let rand = "";
      for (let i = 0; i < 10; i++) rand += alpha[Math.floor(Math.random() * alpha.length)];
      message = `e:TypeError: Cannot read properties of undefined (reading '${rand}')`;
    }

    return btoa(message);
  }

  return "ZTpUeXBlRXJyb3I6IENhbm5vdCByZWFkIHByb3BlcnRpZXMgb2YgdW5kZWZpbmVkIChyZWFkaW5nICdjaGlsZE5vZGVzJyk=";
}
