import jwt from "jsonwebtoken";

export const authMiddleware = (req, res, next) => {
    const header = req.headers.authorization;

    if(!header || !header.startsWith("Bearer ")){
        return res.status(401).json({message:"Unauthorized"});
    }

    const token=header.split(" ")[1];
    try{
        const decoded=jwt.verify(token,process.env.JWT_SECRET);
        req.user={id:decoded.userId};
        next();
    }catch(err){
        return res.status(401).json({message:"invalid token"});
    }
}