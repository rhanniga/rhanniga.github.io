var canvas;
var ctx;

var dot;
var food_array;
var food;

var dots;
var food_x;
var food_y;

var movingLeft = false;
var movingRight = true;
var movingUp = false;
var movingDown = false;
var inGame = true;    

const TEXT_SIZE = 30;
const DOT_SIZE = 90;
const START_DOTS = 3;
const ALL_DOTS = 900;
const MAX_RAND = 10;
const DELAY = 120;

const BUTTON_WIDTH = 100;
const BUTTON_HEIGHT = 60;
const START_BUTTON_X = window.innerWidth/2 - BUTTON_WIDTH/2;
const START_BUTTON_Y = window.innerHeight/2 - BUTTON_HEIGHT/2;
const YES_BUTTON_X = window.innerWidth/2 - BUTTON_WIDTH/2;
const YES_BUTTON_Y = window.innerHeight/2 -100 + 2*TEXT_SIZE*1.5;
const NO_BUTTON_X = window.innerWidth/2 - BUTTON_WIDTH/2;
const NO_BUTTON_Y = window.innerHeight/2 -100 + 2*TEXT_SIZE*1.5 + BUTTON_HEIGHT*1.5;

const LEFT_KEY = 37;
const RIGHT_KEY = 39;
const UP_KEY = 38;
const DOWN_KEY = 40;
const ALT_LEFT_KEY = 65;
const ALT_RIGHT_KEY = 68;
const ALT_DOWN_KEY = 83;
const ALT_UP_KEY = 87;


var x = new Array(ALL_DOTS);
var y = new Array(ALL_DOTS);   

var score_map = new Map();

function init() {
    
    canvas = document.getElementById('gameCanvas');

    // change canvas size to match client window size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight
    ctx = canvas.getContext('2d'); 

    loadImages();

    ctx.fillStyle = 'white';
    ctx.fillRect(START_BUTTON_X, START_BUTTON_Y, BUTTON_WIDTH, BUTTON_HEIGHT);

    ctx.textBaseline = 'middle'; 
    ctx.textAlign = 'center'; 
    ctx.font = 'normal bold ' + String(TEXT_SIZE) +'px monospace';
    ctx.fillStyle = 'black';
    ctx.fillText('START', canvas.width/2, canvas.height/2);
    canvas.addEventListener('click', clickStartButton);

    window.addEventListener("keydown", function(e) {
        if([32, 37, 38, 39, 40].indexOf(e.keyCode) > -1) {
            e.preventDefault();
        }
    }, false);

}    

function resetGame() {

    inGame = true;

    movingLeft = false;
    movingRight = true;
    movingUp = false;
    movingDown = false;

    inGame = true;    
    createSnake();
    locateFood();
    setTimeout("gameCycle()", DELAY);

}

function loadImages() {
    
    dot = new Image();
    dot.src = 'dot.png'; 

    food_array = new Array();

    ryan_face = new Image();
    ryan_face.src = 'faces/ryan.png';
    food_array[0] = ryan_face;

    ray_face = new Image();
    ray_face.src = 'faces/ray.png';
    food_array[1] = ray_face;

    dev_face = new Image();
    dev_face.src = 'faces/dev.png';
    food_array[2] = dev_face;

    ben_face = new Image();
    ben_face.src = 'faces/ben.png';
    food_array[3] = ben_face;

    richard_face = new Image();
    richard_face.src = 'faces/richard.png';
    food_array[4] = richard_face;

    mike_face = new Image();
    mike_face.src = 'faces/mike.png';
    food_array[5] = mike_face;

    esben_face = new Image();
    esben_face.src = 'faces/esben.png';
    food_array[6] = esben_face;

    peter_face = new Image();
    peter_face.src = 'faces/peter.png';
    food_array[7] = peter_face;

/*    jaynee_face = new Image();
    jaynee_face.src = 'faces/jaynee.png';
    food_array[8] = jaynee_face;

    jonathan_face = new Image();
    jonathan_face.src = 'faces/jonathan.png';
    food_array[9] = jonathan_face;

    joseph_face = new Image();
    joseph_face.src = 'faces/joseph.png';
    food_array[10] = joseph_face;
*/

}

function createSnake() {

    dots = START_DOTS;

    for (var z = 0; z < dots; z++) {
        x[z] = 180 - z * DOT_SIZE;
        y[z] = 180;
    }
}

function doDrawing() {
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(food, food_x, food_y, DOT_SIZE, DOT_SIZE);

    for (var z = 0; z < dots; z++) {
        ctx.drawImage(dot, x[z], y[z], DOT_SIZE, DOT_SIZE);
    }    

}

function gameOver() {

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle'; 
    ctx.textAlign = 'center'; 
    ctx.font = 'normal bold ' + String(TEXT_SIZE) +'px monospace';
    
    var go_string = 'Game over, total score: ' + String(dots - START_DOTS);
    ctx.fillText(go_string, canvas.width/2, canvas.height/2 -100);
    ctx.fillText('Play again?', canvas.width/2, canvas.height/2 -100 + TEXT_SIZE*1.5);

    ctx.fillStyle = 'white';
    ctx.fillRect(YES_BUTTON_X, YES_BUTTON_Y, BUTTON_WIDTH, BUTTON_HEIGHT);
    ctx.fillRect(NO_BUTTON_X, NO_BUTTON_Y, BUTTON_WIDTH, BUTTON_HEIGHT);
                 
    ctx.fillStyle = 'black';
    ctx.fillText('YES', 
                 canvas.width/2, 
                 canvas.height/2 -100 + 2*TEXT_SIZE*1.5 + 30);
    ctx.fillText('NO', 
                 canvas.width/2, 
                 canvas.height/2 -100 + 2*TEXT_SIZE*1.5 + BUTTON_HEIGHT*1.5 + 30);

    canvas.addEventListener('click', clickGameOverButtons); 
}

function clickStartButton(event) {

    if (event.x > START_BUTTON_X && 
        event.x < START_BUTTON_X + BUTTON_WIDTH &&
        event.y > START_BUTTON_Y && 
        event.y < START_BUTTON_Y + BUTTON_HEIGHT) {
            createSnake();
            locateFood();
            setTimeout("gameCycle()", DELAY);
            canvas.removeEventListener('click', clickStartButton);
        } 
}

function clickGameOverButtons(event) {

    if (event.x > YES_BUTTON_X && 
        event.x < YES_BUTTON_X + BUTTON_WIDTH &&
        event.y > YES_BUTTON_Y && 
        event.y < YES_BUTTON_Y + BUTTON_HEIGHT) {
            resetGame();
            canvas.removeEventListener('click', clickGameOverButtons); 
        } 

    if (event.x > NO_BUTTON_X && 
        event.x < NO_BUTTON_X + BUTTON_WIDTH &&
        event.y > NO_BUTTON_Y && 
        event.y < NO_BUTTON_Y + BUTTON_HEIGHT) {
            document.getElementById("homeLink").click();
        } 
}
function checkFood() {

    if ((x[0] == food_x) && (y[0] == food_y)) {
        dots += 1;
        locateFood();
    }
}

function move() {

    for (var z = dots; z > 0; z--) {
        x[z] = x[(z - 1)];
        y[z] = y[(z - 1)];
    }

    if (movingLeft) x[0] -= DOT_SIZE;
    if (movingRight) x[0] += DOT_SIZE;
    if (movingUp) y[0] -= DOT_SIZE;
    if (movingDown) y[0] += DOT_SIZE;

}    

function checkCollision() {

    for (var z = dots; z > 0; z--) {

        self_col = (z > 4) && (x[0] == x[z]) && (y[0] == y[z]);
        if (self_col) inGame = false;
       
    }
    // Just trying to keep that sweet column count down...
    var ctx_col = y[0] >= canvas.height || y[0] < 0 || x[0] >= canvas.width || x[0] < 0;
    if (ctx_col) inGame = false;
}

function locateFood() {

    var r = Math.floor(Math.random()*food_array.length);
    food = food_array[r];

    r = Math.floor(Math.random() * MAX_RAND);
    food_x = r * DOT_SIZE;

    r = Math.floor(Math.random() * MAX_RAND);
    food_y = r * DOT_SIZE;

}    

function gameCycle() {
    
    if (inGame) {

        checkFood();
        checkCollision();
        move();
        doDrawing();
        setTimeout("gameCycle()", DELAY);
    }
    else {
        gameOver();
    }
}

onkeydown = function(e) {
    
    var key = e.keyCode;
    
    if ((key == LEFT_KEY || key == ALT_LEFT_KEY)) {

        if(movingRight) inGame = false;

        movingLeft = true;
        movingUp = false;
        movingDown = false;
    }

    if ((key == RIGHT_KEY || key == ALT_RIGHT_KEY)) {
        
        if(movingLeft) inGame = false;

        movingRight = true;
        movingUp = false;
        movingDown = false;
    }

    if ((key == UP_KEY || key == ALT_UP_KEY)) {

        if(movingDown) inGame = false;
        
        movingUp = true;
        movingRight = false;
        movingLeft = false;
    }

    if ((key == DOWN_KEY || key == ALT_DOWN_KEY)) {

        if(movingUp) inGame = false;
        
        movingDown = true;
        movingRight = false;
        movingLeft = false;
    }        
};    
